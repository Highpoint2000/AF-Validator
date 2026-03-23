///////////////////////////////////////////////////////////////
//                                                           //
//  AF VALIDATOR PLUGIN FOR FM-DX-WEBSERVER (V1.0)           //
//                                                           //
//  by Highpoint                last update: 2026-03-23      //
//                                                           //
//  https://github.com/Highpoint2000/AF-Validator            //
//                                                           //
//  Primary:   DTLN (2 models) via ONNX Runtime Web          //
//  Secondary: RNNoise WASM by Shiguredo (MIT)               //
//  VAD:       Silero VAD v4 (ONNX) – RNNoise only           //
//                                                           //
///////////////////////////////////////////////////////////////

(function () {
    "use strict";

    // ── Plugin metadata ────────────────────────────────────────────────────
    var pluginVersion     = "1.0";
    var pluginName        = "AF-Validator";
    var pluginHomepageUrl = "https://github.com/highpointONLINE/AF-Validator/releases";
    var pluginUpdateUrl   = "https://raw.githubusercontent.com/highpoint2000/AF-Validator/main/AF-Validator/af-validator.js";
    var CHECK_FOR_UPDATES = true;
    var DEBUG_LOG         = false;   // set true to enable verbose/repeating logs

    // ── Debug logger ───────────────────────────────────────────────────────
    function _dbg() {
        if (DEBUG_LOG) console.log.apply(console, arguments);
    }

    // ── Configuration ──────────────────────────────────────────────────────
    var API_DIRECT    = "https://maps.fmdx.org/api/";
    var API_PROXY     = "https://cors-proxy.de:13128/https://maps.fmdx.org/api/";
    var CACHE_KEY_PFX = "afval9_";
    var MAX_AGE_MS    = 24 * 60 * 60 * 1000;

    // ── Feature toggles (persisted in localStorage) ────────────────────────
    var _showRing   = localStorage.getItem("afval-show-ring")   !== "false";
    var _showBadges = localStorage.getItem("afval-show-badges") !== "false";

    // ── Module state ───────────────────────────────────────────────────────
    var _lookup     = null;   // { "89.7": ["r.energy", "radio xyz", …], … }  (lowercase station names)
    var _loadedQth  = "";
    var _isFetching = false;
    var _observing  = false;
    var _dbReady    = false;

    var _canvasEl   = null;
    var _canvasCtx  = null;

    var _ok          = 0;
    var _fail        = 0;
    var _unkn        = 0;
    var _stationName = "";   // current station name (lowercase) from #data-station-name
    var _lastAfKey   = "";

    // ── Observer for #data-station-name ───────────────────────────────────
    var _stationNameObserver = null;
    var _stationNameReady    = false;   // true once a non-empty name was seen

    // ======================================================================
    // "Radio X" → "R.X" alias helper
    // e.g. "radio sa"  → "r.sa"
    //      "radio nrj" → "r.nrj"
    // Returns null when the name does not start with "radio ".
    // ======================================================================
    function _radioAlias(nameLC) {
        if (!nameLC || nameLC.indexOf("radio ") !== 0) return null;
        return "r." + nameLC.slice(6);
    }

    // ======================================================================
    // Update check  (mirrors ai-denoise.js pattern)
    // ======================================================================
    function _checkUpdate() {
        fetch(pluginUpdateUrl + "?t=" + Date.now(), { cache: "no-store" })
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (txt) {
                if (!txt) return;
                var m = txt.match(/var\s+pluginVersion\s*=\s*["']([^"']+)["']/);
                if (!m) return;
                var remote = m[1];
                if (remote === pluginVersion) return;
                console.log("[" + pluginName + "] Update available: " + pluginVersion + " → " + remote);

                // ── Inject link into #plugin-settings ─────────────────────
                var settings = document.getElementById("plugin-settings");
                if (settings && settings.innerHTML.indexOf(pluginHomepageUrl) === -1) {
                    settings.innerHTML +=
                        "<br><a href='" + pluginHomepageUrl + "' target='_blank'>[" +
                        pluginName + "] Update: " + pluginVersion + " → " + remote + "</a>";
                }

                // ── Inject red dot on the nav puzzle-piece icon ────────────
                var icon =
                    document.querySelector(".wrapper-outer #navigation .sidenav-content .fa-puzzle-piece") ||
                    document.querySelector(".wrapper-outer .sidenav-content") ||
                    document.querySelector(".sidenav-content");
                if (icon && !icon.querySelector("." + pluginName + "-update-dot")) {
                    var dot = document.createElement("span");
                    dot.className = pluginName + "-update-dot";
                    dot.style.cssText =
                        "display:block;width:12px;height:12px;border-radius:50%;" +
                        "background-color:#FE0830;margin-left:82px;margin-top:-12px;";
                    icon.appendChild(dot);
                }
            })
            .catch(function (e) {
                console.warn("[" + pluginName + "] Update check failed:", e);
            });
    }
    if (CHECK_FOR_UPDATES) _checkUpdate();

    // ======================================================================
    // localStorage helpers
    // ======================================================================
    function _r1(v) { return (Math.round(parseFloat(v) * 10) / 10).toFixed(1); }
    function _ckey(la, lo) { return CACHE_KEY_PFX + _r1(la) + "_" + _r1(lo); }

    function _readCache(la, lo) {
        try {
            var raw = localStorage.getItem(_ckey(la, lo));
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) { return null; }
    }

    function _writeCache(la, lo, lookup) {
        var keysToRemove = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && /^afval\d+_/.test(k) && k.indexOf(CACHE_KEY_PFX) !== 0)
                keysToRemove.push(k);
        }
        keysToRemove.forEach(function (k) { localStorage.removeItem(k); });

        var slim = {};
        for (var freq in lookup) {
            if (!Object.prototype.hasOwnProperty.call(lookup, freq)) continue;
            slim[freq] = lookup[freq];
        }

        try {
            localStorage.setItem(_ckey(la, lo),
                JSON.stringify({ ts: Date.now(), lookup: slim }));
        } catch (e) {
            console.warn("[AF-Validator] localStorage write failed:", e);
        }
    }

    function _lookupFromCache(entry) {
        if (entry.lookup) {
            var out = {};
            for (var freq in entry.lookup) {
                if (!Object.prototype.hasOwnProperty.call(entry.lookup, freq)) continue;
                out[freq] = entry.lookup[freq].map(function (s) {
                    return typeof s === "string" ? s : (s.station || s.name || "");
                });
            }
            return out;
        }
        if (entry.data) return _buildLookup(entry.data);
        return null;
    }

    // ======================================================================
    // Build freq → [stationNameLC, …] lookup from raw API response
    // ======================================================================
    function _buildLookup(api) {
        var out  = {};
        var locs = (api && api.locations) ? api.locations : api;
        for (var lid in locs) {
            if (!Object.prototype.hasOwnProperty.call(locs, lid)) continue;
            var loc = locs[lid];
            if (!loc || !Array.isArray(loc.stations)) continue;
            loc.stations.forEach(function (st) {
                if (st.freq == null) return;
                var fk   = _r1(st.freq);
                var name = (st.station || st.name || "").trim().toLowerCase();
                if (!name) return;
                if (!out[fk]) out[fk] = [];
                out[fk].push(name);
            });
        }
        return out;
    }

    // ======================================================================
    // Toast helpers
    // ======================================================================
    function _toast(type, title, msg, persistent) {
        if (typeof sendToast !== "function") return null;
        sendToast(type, title, msg, !!persistent, false);
        return (typeof $ !== "undefined") ? $("#toast-container .toast").last() : null;
    }
    function _closeToast($t) {
        if ($t && $t.length && typeof closeToast === "function") closeToast($t);
    }

    // ======================================================================
    // Fetch with direct-first, proxy fallback
    // ======================================================================
    function _fetchWithFallback(qthEncoded, onSuccess, onError) {
        var directUrl = API_DIRECT + "?qth=" + qthEncoded;
        var proxyUrl  = API_PROXY  + "?qth=" + qthEncoded;

        fetch(directUrl)
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(onSuccess)
            .catch(function (e1) {
                console.warn("[AF-Validator] Direct fetch failed (" + e1.message + "), trying proxy…");
                fetch(proxyUrl)
                    .then(function (r) {
                        if (!r.ok) throw new Error("HTTP " + r.status);
                        return r.json();
                    })
                    .then(onSuccess)
                    .catch(onError);
            });
    }

    // ======================================================================
    // Database init
    // ======================================================================
    function _initDb(la, lo) {
        var qk    = la + "," + lo;
        var entry = _readCache(la, lo);
        var now   = Date.now();

        if (entry && (entry.lookup || entry.data)) {
            _lookup    = _lookupFromCache(entry);
            _loadedQth = qk;
            _dbReady   = true;
            console.log("[AF-Validator] DB from cache – freq keys:", Object.keys(_lookup).length,
                        "| age:", Math.round((now - entry.ts) / 3600000) + "h");

            if (!_isFetching && (now - entry.ts) > MAX_AGE_MS) {
                setTimeout(function () { _fetchDb(la, lo, true); }, 2000);
            } else {
                requestAnimationFrame(function () {
                    var sn = _currentStationName();
                    if (sn) {
                        _dbg("[AF-Validator] DB ready (cache), station name available:", sn, "– revalidating list.");
                        _revalidateList(sn);
                    } else {
                        _dbg("[AF-Validator] DB ready (cache), station name not yet available – deferring validation.");
                    }
                });
            }
            return;
        }

        _fetchDb(la, lo, false);
    }

    function _fetchDb(la, lo, isBackground) {
        if (_isFetching) return;
        _isFetching = true;

        console.log("[AF-Validator] Fetching DB" + (isBackground ? " (background)" : "") + "…");

        var $dlToast = _toast(
            "info", "AF Validator",
            isBackground
                ? "Refreshing transmitter database in background…"
                : "Downloading transmitter database…",
            true
        );

        _fetchWithFallback(
            encodeURIComponent(la + "," + lo),
            function onSuccess(data) {
                var lk = _buildLookup(data);
                _writeCache(la, lo, lk);
                _lookup     = lk;
                _loadedQth  = la + "," + lo;
                _isFetching = false;
                _dbReady    = true;
                console.log("[AF-Validator] DB ready (network) – freq keys:", Object.keys(_lookup).length);
                _closeToast($dlToast);
                _toast("success", "AF Validator",
                       "Transmitter database updated successfully.", false);

                requestAnimationFrame(function () {
                    var sn = _currentStationName();
                    if (sn) {
                        _dbg("[AF-Validator] DB network ready, station name available:", sn, "– revalidating list.");
                        _revalidateList(sn);
                    } else {
                        _dbg("[AF-Validator] DB network ready, station name not yet available – deferring validation.");
                    }
                });
            },
            function onError(e) {
                _isFetching = false;
                console.warn("[AF-Validator] Both direct and proxy fetch failed:", e);
                _closeToast($dlToast);
                _toast("error", "AF Validator",
                       "Failed to load transmitter database: " + e.message, false);
            }
        );
    }

    // ======================================================================
    // Validate one frequency against a station name (case-insensitive).
    // Also tries the "Radio X" → "R.X" alias.
    // ======================================================================
    function _check(mhz, stationLC) {
        if (!_lookup || !stationLC) return "unknown";
        var list = _lookup[_r1(mhz)];
        if (!list || !list.length) {
            _dbg("[AF-Validator] check", mhz.toFixed(1), "MHz – no DB entry for this frequency → unknown");
            return "unknown";
        }

        // Primary match
        if (list.indexOf(stationLC) !== -1) {
            _dbg("[AF-Validator] check", mhz.toFixed(1), "MHz – PRIMARY MATCH for \"" + stationLC + "\" → ok");
            return "ok";
        }

        // Alias match: "radio x" → "r.x"
        var alias = _radioAlias(stationLC);
        if (alias && list.indexOf(alias) !== -1) {
            _dbg("[AF-Validator] check", mhz.toFixed(1), "MHz – ALIAS MATCH \"" + stationLC + "\" → \"" + alias + "\" → ok");
            return "ok";
        }

        _dbg("[AF-Validator] check", mhz.toFixed(1), "MHz – NO MATCH for \"" + stationLC + "\"" +
            (alias ? " (also tried alias \"" + alias + "\")" : "") +
            " | DB entries: [" + list.join(", ") + "] → fail");
        return "fail";
    }

    // ======================================================================
    // CSS
    // ======================================================================
    function _injectCSS() {
        if (document.getElementById("afval-css")) return;
        var s = document.createElement("style");
        s.id = "afval-css";
        s.textContent = [
            /* AF panel layout */
            ".panel-10.no-bg{display:flex!important;flex-direction:column!important;}",
            ".panel-10.no-bg>.panel-100{display:flex!important;flex-direction:column!important;flex:1;min-height:0;}",

            /* #af-list */
            "#af-list{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;}",

            /* Scrollable list – hidden scrollbar */
            "#af-list ul{flex:1;min-height:0;overflow-y:scroll;overflow-x:hidden;",
            "  scrollbar-width:none;-ms-overflow-style:none;margin:0;padding:0;max-height:none!important;}",
            "#af-list ul::-webkit-scrollbar{display:none;}",

            /* List items */
            "#af-list ul li{list-style:none;white-space:nowrap;line-height:1.45;}",
            "#af-list ul li a{cursor:pointer;color:inherit;",
            "  display:inline-block;min-width:36px;}",

            /* Hover: keep theme underline, prevent colour change to blue/teal */
            "#af-list ul li a:hover{color:inherit;}",

            /* Validation badge */
            ".afv-b{font-size:11px;font-weight:bold;user-select:none;margin-left:2px;",
            "  text-decoration:none!important;}",

            /* Score ring wrapper */
            "#afval-wrap{text-align:center;margin-top:8px;padding-bottom:0px;flex-shrink:0;",
            "  display:flex;flex-direction:column;align-items:center;gap:2px;}",

            /* 'AF Score' label – hidden on phones */
            "#afval-lbl{font-size:10px;color:var(--color-text,#ccc);margin:0;}",
            "@media(max-width:768px){#afval-lbl{display:none!important;}}"
        ].join("");
        document.head.appendChild(s);
    }

    // ======================================================================
    // Ring drawing
    // ======================================================================
    function _hsl(score) { return "hsl(" + Math.round(score * 1.2) + ",88%,45%)"; }

    function _drawRing(score, hasData) {
        _ensureWrap();
        if (!_canvasEl || !_canvasCtx) return;
        var ctx = _canvasCtx, cx = 26, cy = 26, r = 20, lw = 5;
        ctx.clearRect(0, 0, 52, 52);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.strokeStyle = "rgba(255,255,255,0.13)"; ctx.lineWidth = lw; ctx.stroke();
        if (hasData && score > 0) {
            ctx.beginPath();
            ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (score / 100) * 2 * Math.PI);
            ctx.strokeStyle = _hsl(score); ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.stroke();
        }
        ctx.fillStyle    = hasData ? _hsl(score) : "rgba(255,255,255,0.3)";
        ctx.font         = "bold 11px 'Titillium Web',Calibri,sans-serif";
        ctx.textAlign    = "center"; ctx.textBaseline = "middle";
        ctx.fillText(hasData ? (score + "%") : "–", cx, cy);
    }

    function _refreshRing() {
        var v = _ok + _fail;
        _drawRing(v > 0 ? Math.round((_ok / v) * 100) : 0, v > 0);
    }

    function _applyRingVisibility() {
        var wrap = document.getElementById("afval-wrap");
        if (!wrap) return;
        wrap.style.display = _showRing ? "flex" : "none";
    }

    function _applyBadgeVisibility() {
        document.querySelectorAll(".afv-b").forEach(function (b) {
            b.style.display = _showBadges ? "" : "none";
        });
    }

    // ======================================================================
    // Ensure ring wrap exists and is last child of #af-list
    // ======================================================================
    function _ensureWrap() {
        var afList = document.getElementById("af-list");
        if (!afList) return;
        var wrap = document.getElementById("afval-wrap");
        if (wrap) {
            if (afList.lastElementChild !== wrap) afList.appendChild(wrap);
            _applyRingVisibility();
            return;
        }
        wrap             = document.createElement("div");
        wrap.id          = "afval-wrap";
        _canvasEl        = document.createElement("canvas");
        _canvasEl.id     = "afval-canvas";
        _canvasEl.width  = 52;
        _canvasEl.height = 52;
        _canvasCtx       = _canvasEl.getContext("2d");
        var lbl          = document.createElement("div");
        lbl.id           = "afval-lbl";
        lbl.textContent  = "AF Score";
        wrap.appendChild(_canvasEl);
        wrap.appendChild(lbl);
        afList.appendChild(wrap);
        _applyRingVisibility();
    }

    // ======================================================================
    // Badge builder
    // ======================================================================
    function _badge(state, mhz, stationName) {
        var b = document.createElement("span");
        b.className = "afv-b";
        b.style.display = _showBadges ? "" : "none";
        if (!_dbReady || !stationName || state === "pending") {
            // No station name known yet – render empty placeholder badge
            b.textContent = "";
            b.dataset.afvPending = "1";
        } else if (state === "ok") {
            b.textContent = " ✓"; b.style.color = "#4caf50";
            b.title = '"' + stationName + '" confirmed on ' + mhz.toFixed(1) + " MHz";
        } else if (state === "fail") {
            b.textContent = " ✗"; b.style.color = "#f44336";
            b.title = '"' + stationName + '" NOT found on ' + mhz.toFixed(1) + " MHz";
        } else {
            b.textContent = " ?"; b.style.color = "rgba(180,180,180,0.45)";
            b.title = "No database entry for " + mhz.toFixed(1) + " MHz";
        }
        return b;
    }

    // ======================================================================
    // Update an existing badge element in-place
    // ======================================================================
    function _applyBadgeState(b, state, mhz, stationName) {
        delete b.dataset.afvPending;
        if (!_dbReady || !stationName) {
            b.textContent = "";
            b.dataset.afvPending = "1";
            return;
        }
        if (state === "ok") {
            b.textContent = " ✓"; b.style.color = "#4caf50";
            b.title = '"' + stationName + '" confirmed on ' + mhz.toFixed(1) + " MHz";
        } else if (state === "fail") {
            b.textContent = " ✗"; b.style.color = "#f44336";
            b.title = '"' + stationName + '" NOT found on ' + mhz.toFixed(1) + " MHz";
        } else {
            b.textContent = " ?"; b.style.color = "rgba(180,180,180,0.45)";
            b.title = "No database entry for " + mhz.toFixed(1) + " MHz";
        }
        b.style.display = _showBadges ? "" : "none";
    }

    // ======================================================================
    // Current station name – read from #data-station-name (lowercase)
    // ======================================================================
    function _currentStationName() {
        var el = document.getElementById("data-station-name");
        if (!el) return "";
        return (el.textContent || el.innerText || "").trim().toLowerCase();
    }

    // ======================================================================
    // Watch #data-station-name for the moment it gets a real value.
    // When it appears, retroactively validate all pending list items.
    // ======================================================================
    function _installStationNameObserver() {
        var el = document.getElementById("data-station-name");
        if (!el) {
            _dbg("[AF-Validator] #data-station-name not found yet – retrying in 200 ms.");
            setTimeout(_installStationNameObserver, 200);
            return;
        }

        if (_stationNameObserver) _stationNameObserver.disconnect();

        _stationNameObserver = new MutationObserver(function () {
            var sn = _currentStationName();
            if (!sn) return;

            if (sn !== _stationName) {
                _dbg("[AF-Validator] #data-station-name changed: \"" + _stationName + "\" → \"" + sn + "\"");
                _stationName      = sn;
                _stationNameReady = true;

                if (_dbReady) {
                    _dbg("[AF-Validator] DB ready – triggering retroactive validation for \"" + sn + "\".");
                    _revalidateList(sn);
                } else {
                    _dbg("[AF-Validator] DB not yet ready – retroactive validation deferred.");
                }
            }
        });

        _stationNameObserver.observe(el, {
            childList: true,
            characterData: true,
            subtree: true
        });

        _dbg("[AF-Validator] Observer attached to #data-station-name.");

        // Handle the case where the name is already populated when we install
        var snNow = _currentStationName();
        if (snNow && snNow !== _stationName) {
            _dbg("[AF-Validator] #data-station-name already has value on install: \"" + snNow + "\"");
            _stationName      = snNow;
            _stationNameReady = true;
            if (_dbReady) {
                _dbg("[AF-Validator] DB ready – triggering immediate retroactive validation for \"" + snNow + "\".");
                requestAnimationFrame(function () { _revalidateList(snNow); });
            }
        }
    }

    // ======================================================================
    // Override window.createListItem
    // ======================================================================
    function _installCreateListItem() {
        if (typeof window.createListItem !== "function") {
            setTimeout(_installCreateListItem, 100);
            return;
        }
        window.createListItem = function (mhz) {
            var sn = _currentStationName();
            if (sn !== _stationName) _stationName = sn;

            var li = document.createElement("li");
            var a  = document.createElement("a");
            a.textContent = mhz.toFixed(1);
            a.addEventListener("click", (function (f) {
                return function () { if (typeof tuneTo === "function") tuneTo(f); };
            }(mhz)));
            li.appendChild(a);

            if (!sn || !_dbReady) {
                _dbg("[AF-Validator] createListItem " + mhz.toFixed(1) +
                    " MHz – station name" + (!sn ? " empty" : " known but DB not ready") +
                    " → pending badge");
                li.appendChild(_badge("pending", mhz, sn));
                _unkn++;
            } else {
                var state = _check(mhz, sn);
                if      (state === "ok")   _ok++;
                else if (state === "fail") _fail++;
                else                       _unkn++;
                li.appendChild(_badge(state, mhz, sn));
            }

            return li;
        };
        console.log("[AF-Validator] createListItem override installed.");
    }

    // ======================================================================
    // MutationObserver on AF <ul>
    // ======================================================================
    function _installObserver() {
        var afList = document.getElementById("af-list");
        if (!afList) { setTimeout(_installObserver, 200); return; }
        var ul = afList.querySelector("ul");
        if (!ul) {
            var w = new MutationObserver(function () {
                ul = afList.querySelector("ul");
                if (ul) { w.disconnect(); _attachUlObserver(ul); }
            });
            w.observe(afList, { childList: true });
            return;
        }
        _attachUlObserver(ul);
    }

    function _attachUlObserver(ul) {
        var obs = new MutationObserver(function (mutations) {
            var hadRemovals = mutations.some(function (m) {
                return Array.prototype.some.call(m.removedNodes, function (n) {
                    return n.nodeName === "LI";
                });
            });
            if (hadRemovals && ul.querySelectorAll("li").length === 0) {
                _dbg("[AF-Validator] AF list cleared – resetting counters and ring.");
                _ok = 0; _fail = 0; _unkn = 0; _stationName = "";
                _lastAfKey = "";
                _drawRing(0, false);
                return;
            }

            var hasLi = mutations.some(function (m) {
                return Array.prototype.some.call(m.addedNodes, function (n) {
                    return n.nodeName === "LI";
                });
            });
            if (!hasLi || _observing) return;
            _observing = true;
            requestAnimationFrame(function () {
                _observing = false;
                _afterListRebuild();
            });
        });
        obs.observe(ul, { childList: true });
        console.log("[AF-Validator] Observer attached to AF <ul>.");
    }

    // ======================================================================
    // After main.js finishes rebuilding the list
    // ======================================================================
    function _afterListRebuild() {
        _ensureWrap();

        var afList  = document.getElementById("af-list");
        var anchors = afList ? afList.querySelectorAll("ul > li a") : [];
        var afKey   = Array.prototype.map.call(anchors, function (a) {
            return a.textContent;
        }).join(",");

        var sn = _currentStationName();

        if (afKey !== _lastAfKey || sn !== _stationName) {
            _lastAfKey   = afKey;
            _stationName = sn;
            _ok          = 0;
            _fail        = 0;
            _unkn        = 0;
            _drawRing(0, false);
        }

        if (!anchors.length) { _drawRing(0, false); return; }

        if (!sn) {
            _dbg("[AF-Validator] _afterListRebuild: station name not yet available – badges will be applied when name arrives.");
            _drawRing(0, false);
            return;
        }

        if (_dbReady) {
            _dbg("[AF-Validator] _afterListRebuild: revalidating list for \"" + sn + "\".");
            _revalidateList(sn);
        } else {
            _dbg("[AF-Validator] _afterListRebuild: DB not ready – validation deferred.");
        }
    }

    // ======================================================================
    // Full revalidation pass – updates existing badges in-place
    // ======================================================================
    function _revalidateList(stationLC) {
        var afList = document.getElementById("af-list");
        if (!afList) return;

        _dbg("[AF-Validator] _revalidateList: start for station \"" + stationLC + "\"");

        _ok = 0; _fail = 0; _unkn = 0; _stationName = stationLC;

        afList.querySelectorAll("ul > li").forEach(function (li) {
            var a = li.querySelector("a");
            if (!a) return;
            var mhz = parseFloat(a.textContent);
            if (isNaN(mhz) || mhz < 65 || mhz > 108) return;

            var state = _check(mhz, stationLC);
            if      (state === "ok")   _ok++;
            else if (state === "fail") _fail++;
            else                       _unkn++;

            var old = li.querySelector(".afv-b");
            if (old) {
                _applyBadgeState(old, state, mhz, stationLC);
            } else {
                li.appendChild(_badge(state, mhz, stationLC));
            }
        });

        _dbg("[AF-Validator] _revalidateList: done – ok=" + _ok +
            " fail=" + _fail + " unknown=" + _unkn);

        if (_showRing) _refreshRing();
        _ensureWrap();
    }

    // ======================================================================
    // Settings toggles  (in-modal gear icon only – no setup page rows)
    // ======================================================================
    function _replaceText(node, regex, replacement) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (regex.test(node.textContent))
                node.textContent = node.textContent.replace(regex, replacement);
        } else {
            Array.prototype.forEach.call(node.childNodes, function (child) {
                _replaceText(child, regex, replacement);
            });
        }
    }

    function _makeToggle(newId, labelText, currentValue, onChange) {
        var imperialCheckbox = document.getElementById("imperial-units");
        if (!imperialCheckbox) return null;

        var wrapper = imperialCheckbox;
        while (wrapper && wrapper.parentElement &&
               !wrapper.parentElement.classList.contains("auto")) {
            wrapper = wrapper.parentElement;
        }
        if (!wrapper) return null;

        var clone = wrapper.cloneNode(true);
        clone.classList.add("hide-phone");

        var inp = clone.querySelector("input[type='checkbox']");
        if (inp) { inp.id = newId; inp.checked = currentValue; }

        var lbl = clone.tagName.toLowerCase() === "label"
            ? clone : clone.querySelector("label");
        if (lbl && lbl.hasAttribute("for")) lbl.setAttribute("for", newId);

        _replaceText(clone, /imperial units/i, labelText);

        clone.addEventListener("change", function (e) {
            if (e.target.id === newId) onChange(e.target.checked);
        });

        return clone;
    }

    function _setupSettingsToggles() {
        if (document.getElementById("afval-toggle-ring")) return;

        var settingsContainer = document.querySelector(".modal-panel-content .auto");
        if (!settingsContainer) return;

        var cloneBadges = _makeToggle(
            "afval-toggle-badges",
            "AF Badges",
            _showBadges,
            function (checked) {
                _showBadges = checked;
                localStorage.setItem("afval-show-badges", _showBadges);
                _applyBadgeVisibility();
            }
        );

        var cloneRing = _makeToggle(
            "afval-toggle-ring",
            "AF Score Ring",
            _showRing,
            function (checked) {
                _showRing = checked;
                localStorage.setItem("afval-show-ring", _showRing);
                _applyRingVisibility();
                if (_showRing) _refreshRing();
            }
        );

        if (cloneBadges) settingsContainer.appendChild(cloneBadges);
        if (cloneRing)   settingsContainer.appendChild(cloneRing);
    }

    // ======================================================================
    // Plugin settings page (/setup) – name/version heading + update link only
    // ======================================================================
    function _setupPageToggles() {
        if (window.location.pathname.indexOf("/setup") === -1) return;
        if (document.getElementById("afval-setup-heading")) return;

        var container = document.getElementById("plugin-settings");
        if (!container) return;

        if (container.textContent.trim() === "No plugin settings are available.") {
            container.textContent = "";
        }

        var heading = document.createElement("strong");
        heading.id          = "afval-setup-heading";
        heading.textContent = pluginName + " v" + pluginVersion;
        container.appendChild(heading);
        // Update link is injected by _checkUpdate() into #plugin-settings when available
    }

    // ======================================================================
    // Bootstrap
    // ======================================================================
    function _init() {
        console.log("[AF-Validator] Initialising… v" + pluginVersion);
        _injectCSS();
        _ensureWrap();
        _drawRing(0, false);
        _installCreateListItem();
        _installObserver();
        _installStationNameObserver();

        document.addEventListener("click", function () {
            setTimeout(_setupSettingsToggles, 300);
        });

        _setupPageToggles();
        setTimeout(_setupPageToggles, 1000);

        // ── Load DB – poll until QTH is available ──────────────────────────
        var attempts = 0;
        var poll = setInterval(function () {
            var la = localStorage.getItem("qthLatitude");
            var lo = localStorage.getItem("qthLongitude");
            attempts++;
            var valid = la && lo &&
                        la !== "null" && lo !== "null" &&
                        la !== "0"    && lo !== "0"    &&
                        !isNaN(parseFloat(la)) && !isNaN(parseFloat(lo));
            if (valid || attempts > 30) {
                clearInterval(poll);
                if (valid) {
                    console.log("[AF-Validator] QTH found:", la, lo);
                    _initDb(la, lo);
                } else {
                    console.warn("[AF-Validator] QTH not available after 30 s.");
                }
            }
        }, 1000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () { setTimeout(_init, 400); });
    } else {
        setTimeout(_init, 400);
    }

}());