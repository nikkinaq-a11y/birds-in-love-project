// Clearing Dance: a parotia courtship display, played with your body.
// Input: webcam -> PoseNet -> Teachable Machine classifier.
// Output: the male parotia mirrors your detected move; the female judges it from her branch.
// Feedback: she walks closer along the branch when you dance well and backs away when you don't.

const MODEL_URL = "./model/";
const MOVES = ["Beak", "Flap", "Boogie", "Clap"];

// Song timing, measured from assets/chicken-dance.mp3
const BPM = 94.04;
const FIRST_BEAT = 0.34;                 // seconds
const VERSE_STARTS = [12, 76, 140, 204]; // in beats
const CHORUS_STARTS = [44, 108, 172];
const SECTION_BEATS = 32;
const BEATS_PER_MOVE = 2;
const MOVE_OFFSET = 0;                   // shift if the song's first move isn't Beak (0-3)
const SONG_END_BEAT = 236;

// Judging
const CONFIDENCE = 0.7;     // a frame counts as a hit if the cued move is at least this likely
const PERFECT_RATIO = 0.5;  // share of frames in a move window that must be hits
const GOOD_RATIO = 0.2;
const GRACE = 0.3;          // seconds ignored at the start of each move, to switch poses
const START_INTEREST = 35;
const WIN_INTEREST = 60;
const PX_PER_SEC = 210;     // cue track scroll speed

// Smoothing for the male's animation (judging still uses the raw predictions)
const SMOOTHING = 0.25;     // how fast the averaged probabilities follow the model (0..1)
const POSE_HOLD_MS = 300;   // a new move must hold this long before he switches

// Branch path the female walks along (scene fractions; first = closest to the male)
const BRANCH = [
  [0.47, 0.247], [0.50, 0.253], [0.55, 0.228], [0.60, 0.206],
  [0.65, 0.179], [0.70, 0.150], [0.75, 0.133], [0.80, 0.111],
];

const $ = (id) => document.getElementById(id);
const els = {
  curtains: $("curtains"),
  curtainContent: $("curtain-content"),
  playBtn: $("play-btn"),
  startBtn: $("start-btn"),
  playLabel: $("play-label"),
  status: $("status"),
  results: $("results"),
  canvas: $("cam-canvas"),
  debug: $("debug"),
  score: $("score"),
  combo: $("combo"),
  message: $("message"),
  cues: $("cues"),
  rating: $("rating"),
  male: $("male"),
  female: $("female"),
  song: $("song"),
  pauseBtn: $("pause-btn"),
  pauseScreen: $("pause-screen"),
};
const ctx = els.canvas.getContext("2d");
const DEBUG = new URLSearchParams(location.search).has("debug");

let model, webcam, labels;
let setupPromise = null;
let state = "idle"; // idle | intro | playing | paused | done
let timeline = [];
let game;
const female = { pos: 1 - START_INTEREST / 100, target: 1 - START_INTEREST / 100, face: -1, stillSince: 0, landed: false };
const LANDING_SPOT = [0.64, 0.86]; // on the clearing floor, beside the male
const male = { smoothed: null, candidate: null, candidateSince: 0 };

// ---------- Start ----------

els.playBtn.addEventListener("click", onPlay);
els.startBtn.addEventListener("click", onStartDancing);
els.pauseBtn.addEventListener("click", pauseGame);

// The intro text is kept no wider than the PLAY button
function sizeIntro() {
  els.curtainContent.style.setProperty("--play-w", els.playBtn.offsetWidth + "px");
}
document.fonts.ready.then(sizeIntro);
window.addEventListener("resize", sizeIntro);
$("resume-btn").addEventListener("click", resumeGame);
$("restart-btn").addEventListener("click", startGame);

document.addEventListener("keydown", (e) => {
  if (![" ", "p", "P", "Escape"].includes(e.key)) return;
  if (state === "playing") pauseGame();
  else if (state === "paused") resumeGame();
  else return;
  e.preventDefault();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state === "playing") pauseGame();
});

if (location.protocol === "file:") {
  els.status.textContent = "Open this page with Live Server. The model can't load from a file:// URL.";
}

// PLAY: first time, swap to the intro and load in the background; after a game, replay right away
function onPlay() {
  if (state === "idle") {
    state = "intro";
    els.curtainContent.dataset.step = "intro";
    unlockAudio();
    loadEverything().catch(() => {}); // errors are shown in the status line
  } else if (state === "done") {
    startGame();
  }
}

async function onStartDancing() {
  if (state !== "intro") return;
  if (!model) unlockAudio();
  els.startBtn.disabled = true;
  els.startBtn.textContent = "Getting ready…";
  try {
    await loadEverything();
  } catch {
    els.startBtn.disabled = false;
    els.startBtn.textContent = "Try again";
    return;
  }
  startGame();
}

// Let the song play later even though loading happens between the click and the music
function unlockAudio() {
  els.song.play().then(() => { if (state !== "playing") els.song.pause(); }).catch(() => {});
}

function loadEverything() {
  if (!setupPromise) {
    setupPromise = setup().catch((err) => {
      console.error(err);
      els.status.textContent = "Couldn't start: " + err.message;
      setupPromise = null;
      throw err;
    });
  }
  return setupPromise;
}

async function setup() {
  model = await tmPose.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
  labels = model.getClassLabels();
  if (DEBUG) buildDebug();

  els.status.textContent = "Allow camera access to dance";
  webcam = new tmPose.Webcam(200, 200, true);
  await webcam.setup();
  await webcam.play();
  els.status.textContent = "";
  requestAnimationFrame(loop);
}

function startGame() {
  game = { score: 0, combo: 0, best: 0, interest: START_INTEREST, perfect: 0, good: 0, miss: 0 };
  female.target = 1 - game.interest / 100;
  timeline = buildTimeline();
  buildCueCards();
  renderHud();

  female.landed = false;
  els.female.classList.remove("landing");

  els.results.hidden = true;
  els.curtainContent.dataset.step = "play";
  els.pauseScreen.hidden = true;
  els.pauseBtn.hidden = false;
  els.curtains.classList.add("open");
  setTimeout(() => els.curtains.classList.add("gone"), 1800);

  els.song.currentTime = 0;
  els.song.play();
  state = "playing";
}

function pauseGame() {
  if (state !== "playing") return;
  state = "paused";
  els.song.pause();
  els.pauseScreen.hidden = false;
}

function resumeGame() {
  if (state !== "paused") return;
  els.pauseScreen.hidden = true;
  els.song.play();
  state = "playing";
}

// ---------- Main loop ----------

let lastFrame = performance.now();

async function loop(now) {
  webcam.update();
  const { posenetOutput } = await model.estimatePose(webcam.canvas);
  const prediction = await model.predict(posenetOutput);

  ctx.drawImage(webcam.canvas, 0, 0);
  updateMale(prediction, now);
  if (DEBUG) updateDebug(prediction);
  if (state === "playing") tick(prediction);

  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  updateFemale(dt, now);

  requestAnimationFrame(loop);
}

// The male shows what the model thinks you're doing, smoothed so he doesn't flicker between moves
function updateMale(prediction, now) {
  male.smoothed = prediction.map((p, i) =>
    male.smoothed ? male.smoothed[i] + (p.probability - male.smoothed[i]) * SMOOTHING : p.probability
  );
  let best = 0;
  male.smoothed.forEach((v, i) => { if (v > male.smoothed[best]) best = i; });
  const cls = prediction[best].className;
  const next = cls !== "Idle" && male.smoothed[best] >= 0.6 ? cls.toLowerCase() : "idle";

  if (next === els.male.dataset.pose) {
    male.candidate = null;
  } else if (next !== male.candidate) {
    male.candidate = next;
    male.candidateSince = now;
  } else if (now - male.candidateSince >= POSE_HOLD_MS) {
    setMalePose(next);
    male.candidate = null;
  }
}

// Start the new move's animation in step with the song's beat
function setMalePose(pose) {
  const beat = 60 / BPM;
  const t = state === "playing" ? els.song.currentTime - FIRST_BEAT : performance.now() / 1000;
  const phase = ((t % beat) + beat) % beat;
  els.male.style.setProperty("--phase", `-${phase.toFixed(3)}s`);
  els.male.dataset.pose = pose;
}

function probabilityOf(prediction, className) {
  const p = prediction.find((x) => x.className === className);
  return p ? p.probability : 0;
}

// ---------- Timeline ----------

const beatTime = (beat) => FIRST_BEAT + (beat * 60) / BPM;

function buildTimeline() {
  const events = [];
  for (const start of VERSE_STARTS) {
    const count = Math.min(SECTION_BEATS, SONG_END_BEAT - start) / BEATS_PER_MOVE;
    for (let i = 0; i < count; i++) {
      const b = start + i * BEATS_PER_MOVE;
      events.push({
        type: "move",
        move: MOVES[(i + MOVE_OFFSET) % MOVES.length],
        start: beatTime(b),
        end: beatTime(b + BEATS_PER_MOVE),
        frames: 0,
        hits: 0,
        judged: false,
      });
    }
  }
  for (const start of CHORUS_STARTS) {
    events.push({ type: "free", move: "Free", start: beatTime(start), end: beatTime(start + SECTION_BEATS) });
  }
  return events.sort((a, b) => a.start - b.start);
}

function buildCueCards() {
  els.cues.innerHTML = "";
  for (const e of timeline) {
    const card = document.createElement("div");
    card.className = "cue";
    card.dataset.move = e.move;
    card.style.width = (e.end - e.start) * PX_PER_SEC - 6 + "px";
    card.textContent = e.type === "free" ? "Free dance! Show off for her" : e.move;
    els.cues.appendChild(card);
    e.card = card;
  }
}

function renderCues(t) {
  const hitX = els.cues.clientWidth * 0.18;
  for (const e of timeline) {
    const x = hitX + (e.start - t) * PX_PER_SEC;
    e.card.style.transform = `translateX(${x.toFixed(1)}px)`;
  }
}

// ---------- Game ----------

function tick(prediction) {
  const t = els.song.currentTime;
  renderCues(t);
  renderMessage(t);

  for (const e of timeline) {
    if (e.type !== "move" || e.judged) continue;
    if (t >= e.start + GRACE && t < e.end) {
      e.frames++;
      if (probabilityOf(prediction, e.move) >= CONFIDENCE) e.hits++;
    } else if (t >= e.end) {
      judge(e);
    }
  }

  if (t >= beatTime(SONG_END_BEAT) + 1 || els.song.ended) endGame();
}

function renderMessage(t) {
  const firstMove = beatTime(VERSE_STARTS[0]);
  let html = "";
  if (t < firstMove) {
    const beatsLeft = Math.ceil((firstMove - t) * BPM / 60);
    html = beatsLeft <= 4
      ? String(beatsLeft)
      : "Step into the clearing<small>Back up until your head, arms and waist fit in the camera</small>";
  }
  if (els.message.innerHTML !== html) els.message.innerHTML = html;
}

function judge(e) {
  e.judged = true;
  const ratio = e.frames ? e.hits / e.frames : 0;
  const result = ratio >= PERFECT_RATIO ? "perfect" : ratio >= GOOD_RATIO ? "good" : "miss";
  e.card.classList.add(result);
  game[result]++;

  if (result === "miss") {
    game.combo = 0;
    game.interest -= 5;
  } else {
    game.combo++;
    game.best = Math.max(game.best, game.combo);
    game.score += (result === "perfect" ? 100 : 50) * (1 + Math.floor(game.combo / 8));
    game.interest += result === "perfect" ? 6 : 3;
    if (result === "perfect" && game.combo % 4 === 0) spawnHearts(2);
  }
  game.interest = Math.max(0, Math.min(100, game.interest));
  female.target = 1 - game.interest / 100;
  showRating(result);
  renderHud();
}

function renderHud() {
  els.score.textContent = game.score;
  els.combo.textContent = game.combo;
  document.documentElement.style.setProperty("--glow", Math.min(game.combo / 12, 1).toFixed(2));
}

function showRating(result) {
  els.rating.className = "rating";
  void els.rating.offsetWidth; // restart the animation
  els.rating.textContent = { perfect: "PERFECT!", good: "GOOD", miss: "MISS" }[result];
  els.rating.classList.add("show", result);
}

function endGame() {
  state = "done";
  els.song.pause();
  els.pauseBtn.hidden = true;
  els.message.innerHTML = "";
  const won = game.interest >= WIN_INTEREST;
  if (won) {
    flyDown();
    setTimeout(() => spawnHearts(6), 1900);
  }

  setTimeout(() => {
    els.results.innerHTML = `
      <h1>${won ? "She chose you!" : "She flew off…"}</h1>
      <p>${won ? "Your display won her over." : "Your display didn't impress her this time."}</p>
      <p>Score ${game.score} · Best combo ${game.best} · ${game.perfect} perfect · ${game.good} good · ${game.miss} missed</p>`;
    els.results.hidden = false;
    els.playLabel.textContent = "AGAIN";
    els.curtains.classList.remove("open", "gone");
  }, won ? 4200 : 2200);
}

// ---------- Female ----------

function branchPoint(p) {
  const f = Math.max(0, Math.min(1, p)) * (BRANCH.length - 1);
  const i = Math.min(BRANCH.length - 2, Math.floor(f));
  const k = f - i;
  return [BRANCH[i][0] + (BRANCH[i + 1][0] - BRANCH[i][0]) * k, BRANCH[i][1] + (BRANCH[i + 1][1] - BRANCH[i][1]) * k];
}

function flyDown() {
  female.landed = true;
  els.female.classList.remove("walking");
  els.female.classList.add("landing");
  els.female.style.setProperty("--face", -1); // face him as she lands
  els.female.style.left = LANDING_SPOT[0] * 100 + "%";
  els.female.style.top = LANDING_SPOT[1] * 100 + "%";
}

// She walks toward her target spot, faces the way she's walking, then turns to watch him
function updateFemale(dt, now) {
  if (female.landed) return;
  const delta = female.target - female.pos;
  const step = Math.sign(delta) * Math.min(Math.abs(delta), 0.12 * dt);
  const moving = Math.abs(delta) > 0.002;
  female.pos += step;

  if (moving) {
    female.face = step < 0 ? -1 : 1; // the art faces right; closer is to the left
    female.stillSince = now;
  } else if (now - female.stillSince > 1500) {
    female.face = -1; // settled: turn to watch the male
  }

  const [x, y] = branchPoint(female.pos);
  els.female.style.left = (x * 100).toFixed(2) + "%";
  els.female.style.top = (y * 100).toFixed(2) + "%";
  els.female.style.setProperty("--face", female.face);
  els.female.classList.toggle("walking", moving);
  els.female.classList.toggle("smitten", game ? game.interest >= WIN_INTEREST : false);
}

function spawnHearts(n) {
  for (let i = 0; i < n; i++) {
    const h = document.createElement("span");
    h.className = "heart";
    h.textContent = "❤";
    h.style.setProperty("--dx", (Math.random() * 4 - 2).toFixed(1) + "vw");
    h.style.animationDelay = i * 0.15 + "s";
    els.female.appendChild(h);
    setTimeout(() => h.remove(), 2000);
  }
}

// ---------- Debug (add ?debug to the URL) ----------

function buildDebug() {
  els.debug.hidden = false;
  els.debug.innerHTML = labels.map((l) => `<div class="bar"><span>${l}</span><div class="track"><div class="fill"></div></div></div>`).join("") + `<div id="beat"></div>`;
}

function updateDebug(prediction) {
  prediction.forEach((p, i) => {
    els.debug.children[i].querySelector(".fill").style.width = (p.probability * 100).toFixed(0) + "%";
  });
  const beat = (els.song.currentTime - FIRST_BEAT) * BPM / 60;
  $("beat").textContent = `t ${els.song.currentTime.toFixed(2)}s · beat ${Math.floor(beat)}`;
}
