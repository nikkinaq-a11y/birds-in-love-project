# Strut: A Courtship Dance

A webcam dance game built with TensorFlow.js and Teachable Machine. You play a rooster performing a courtship display (the chicken dance) for a hen. A pose model recognizes your moves, and the hen judges how well you keep to the routine.

## Biomimicry

Many birds court with a fixed, rehearsed routine, and the female chooses based on how precisely it is performed: Western parotias, blue-footed boobies, sage grouse on a lek, Clark's grebes. Strut turns that into an interaction:

- **The display:** four moves on the beat: Beak, Flap, Boogie, Clap. Each round is faster, like an escalating display.
- **The judge:** the hen. She moves closer, blushes and sends hearts when you hit moves, and turns away when you miss.
- **Plumage:** the rooster's tail feathers brighten and glow as your combo grows, an honest signal of a good performance.

The chicken dance itself started as a Swiss song, *Der Ententanz* ("The Duck Dance").

## How it works

1. The webcam feeds **PoseNet** (through `@teachablemachine/pose`), which finds your body.
2. A **Teachable Machine** classifier trained on five classes (Beak, Flap, Boogie, Clap, Idle) labels each frame.
3. A timeline cues one move every 4 beats. A move counts if the model detects it with at least 70% confidence for enough of its window: 50% of frames for PERFECT, 20% for GOOD.
4. The rooster mirrors whatever the model detects, so you can see what it sees.
5. The hen's interest goes up or down after every move. Finish at 60% or higher and she accepts.

The music is synthesized in the browser with the Web Audio API, so there are no audio files.

## Run locally

The model files have to be served over HTTP, and camera access needs `localhost` or HTTPS.

1. Open this folder in VS Code.
2. Right-click `index.html` and choose **Open with Live Server**.
3. Allow camera access, step back so your head, arms and waist are in the camera box, then press **Begin the dance**.

## Files

- `index.html`: page layout and the rooster and hen SVG art
- `style.css`: scenery, character poses and animations
- `game.js`: model loading, webcam loop, timeline, scoring, hen reactions, music
- `model/`: the Teachable Machine pose model export (`model.json`, `metadata.json`, `weights.bin`)

## Tuning

The constants at the top of `game.js` control difficulty: `ROUNDS` (tempos), `CONFIDENCE`, `PERFECT_RATIO`, `GOOD_RATIO` and `WIN_INTEREST`.
