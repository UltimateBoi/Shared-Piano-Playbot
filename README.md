***

# Shared-Piano-Playbot (v2.0)

🎵 Play MIDI files on **Google Shared Piano** with a fast, feature‑rich controller.  
**Load • Play • Pause • Stop • Seek • Transpose • Sustain • Speed (unlimited) • Advanced scheduler • Draggable panel**

## Play Demo

Please click the gif below to watch full video :)
[![playbot_demo](https://user-images.githubusercontent.com/77003554/184627712-c3ebbe96-7f9f-4f0c-a312-c6143e20d4cc.gif)](https://drive.google.com/file/d/1zJCgLY74Kt_SCeB8_HkQp3melCtlrFpe/view?usp=sharing)

***

## Main Features

*   Auto‑play **MIDI** files on Shared Piano
*   **Pause / Resume / Stop**
*   **Seek** (scrub & manual seconds)
*   **Transpose** (buttons + manual semitone input)
*   **Auto sustain** with **interval control** (slider + manual ms, unlimited)
*   **Speed control** (slider + unlimited manual input)
*   **Advanced scheduler tuning** (lookahead tick & schedule‑ahead window)
*   **Draggable, autosized panel** (move anywhere, saved position)
*   **Efficient loading** for big MIDIs (fast sort + smart prewarm)

***

## How to Install

1. Install [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) chrome extension.
2.  Create a new userscript and paste the **Playbot v2.0** code.
3.  Visit **Shared Piano**—Tampermonkey will auto‑run the script.

***

## How to Use

1.  Open Shared Piano and press **`Ctrl + M`** to load a `.mid` file.
2.  Press **Play** (or **`Enter`**) to start.
    *   Playback starts after a user gesture to satisfy the browser’s autoplay policy.
3.  Use the **panel** to control **Pause/Resume/Stop**, adjust **Speed**, **Sustain**, **Transpose**, or **Seek**.
4.  Drag the **title bar** to move the panel; it auto‑sizes and remembers its position.

***

## Shortcuts

### Main controls

*   Load file: **`Ctrl + M`**
*   Play / Resume: **`Enter`**

### Transpose

*   Pitch +1: **`+`**
*   Pitch −1: **`-`**

### Sustain (quick tweaks)

*   Turn off sustain cycle: **`←`** *(panel toggle also available)*
*   Minimum interval (rapid retrigger): **`→`**
*   Longer interval: **`↑`**
*   Shorter interval: **`↓`**

*(All of these can also be adjusted from the panel with sliders or manual inputs.)*

***

## Panel Overview

*   **Play / Pause / Stop / Load**: main transport.
*   **Seek**: drag to scrub or type seconds; shows current/effective duration based on speed.
*   **Transpose**: ± buttons and manual entry.
*   **Sustain**: toggle **Auto**, set interval (slider or **any ms** manually), and **Link to speed** for musical sustain at faster/slower tempos.
*   **Speed**: slider for convenience, **manual input with no limit** (e.g., `5.0×`). Changes keep your current musical position.
*   **Advanced ▾**: tune **Lookahead (ms)** and **Schedule‑ahead (s)** to balance smoothness vs. CPU for very dense pieces.

***

## Tips & Troubleshooting

*   **If audio doesn’t start**: click **Play** once (or press **Enter**) to resume audio—browsers block autoplay until a user gesture.
*   **“Samples not loaded”** warnings: the bot **prewarms** octaves and uses the official input API when available; give it a moment after loading big files.
*   **Large MIDIs (200 KB+)**: v2.0’s **fast sort + rolling scheduler** keeps things responsive; you can increase **Lookahead** or **Schedule‑ahead** in **Advanced** if needed.
*   **Sustain clipping**: very long sustain at high velocity can cause clipping; reduce sustain interval or turn off auto sustain briefly.

***

## Roadmap / Ideas

*   Velocity curve mapping (MIDI velocity → press duration/strength)
*   Tempo overlay / beat snapping for seek
*   Optional progress bar in measures/beats

***
