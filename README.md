# AF Validator
Validates the determined station name for correctness using alternative frequencies in the database.

<img width="1224" height="849" alt="grafik" src="https://github.com/user-attachments/assets/936e4701-af1a-42b5-bdec-0706c87451d2" />


## Version 1.0a

- Additional play button removed from mobile devices

## Installation notes:

1. [Download](https://github.com/Highpoint2000/AF-Validator/releases) the last repository as a zip
2. Unpack all files from the plugins folder to ..fm-dx-webserver-main\plugins\ 
3. Stop or close the fm-dx-webserver
4. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations
5. Activate the AF Vadlidator plugin in the settings
6. Stop or close the fm-dx-webserver
7. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations 
8. Reload the browser

## How to use:     
                                         
You can toggle two visual elements on and off directly on the setting page:

- AF Badges – shows or hides the ✓ / ✗ symbols next to each frequency in the AF list
- AF Score Ring – shows or hides the colour-coded percentage ring at the bottom of the AF panel

## Contact

If you have any questions, would like to report problems, or have suggestions for improvement, please feel free to contact me! You can reach me by email at highpoint2000@googlemail.com. I look forward to hearing from you!

<a href="https://www.buymeacoffee.com/Highpoint" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

<details>
<summary>History</summary>

### Version 1.0

- Automatic AF Validation – Every Alternative Frequency in the RDS AF list is checked against the FMDX transmitter database (maps.fmdx.org) and marked with a green ✓ or red ✗ badge
- AF Score Ring – A colour-coded canvas ring (red → yellow → green) displays the overall match percentage for the current station's AF list at a glance
- Persistent Local Cache – The transmitter database is stored in localStorage and silently refreshed once per day; toasts only appear on real network activity
