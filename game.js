// Strut: a chicken-dance courtship game.
// Input: webcam -> PoseNet -> Teachable Machine classifier.
// Output: the rooster mirrors your detected move; the hen judges it.
// Feedback: her distance, mood, and the score tell you how to adjust.

const MODEL_URL = "./model/";
const MOVES = ["Beak", "Flap", "Boogie", "Clap"];
const ROUNDS = [{ bpm: 100 }, { bpm: 118 }, { bpm: 136 }]; // the song speeds up each time
const CYCLES_PER_ROUND = 2;
const BEATS_PER_MOVE = 4;
const CONFIDENCE = 0.7;       // a frame counts as a hit if the cued move is at least this likely
const PERFECT_RATIO = 0.5;    // share of frames in a move window that must be hits
const GOOD_RATIO = 0.2;
const WIN_INTEREST = 60;
const LEAD_IN = 0.6;          // seconds before the first count-in beat
const PX_PER_SEC = 240;       // cue track scroll speed

const $ = (id) => document.getElementById(id);
const els = {
  overlay: $("overlay"),
  status: $("status"),
  startBtn: $("start-btn"),
  canvas: $("cam-canvas"),
  bars: $("bars"),
  score: $("score"),
  combo: $("combo"),
  round: $("round"),
  affection: $("affection-fill"),
  moveName: $("move-name"),
  beatDots: $("beat-dots"),
  rating: $("rating"),
  cues: $("cues"),
  rooster: $("rooster"),
  hen: $("hen"),
  henWrap: $("hen-wrap"),
};
const ctx = els.canvas.getContext("2d");

let model, webcam, labels;
let audio, master, noiseBuffer;
let timeline = null;   // { events, end }
let audioStart = 0;
let state = "loading"; // loading | ready | playing | done
let game;

// ---------- Setup ----------

els.startBtn.addEventListener("click", onStartClick);

if (location.protocol === "file:") {
  els.status.textContent = "Open this page with Live Server (or any web server). The model can't load from a file:// URL.";
}

async function onStartClick() {
  if (state === "loading") {
    els.startBtn.disabled = true;
    try {
      await setup();
    } catch (err) {
      console.error(err);
      els.status.textContent = "Couldn't start: " + err.message;
      els.startBtn.disabled = false;
      return;
    }
    state = "ready";
    els.status.textContent = "Step back until your head and arms fit in the camera box, then begin.";
    els.startBtn.textContent = "Begin the dance";
    els.startBtn.disabled = false;
  } else if (state === "ready" || state === "done") {
    startGame();
  }
}

async function setup() {
  els.status.textContent = "Loading the model…";
  model = await tmPose.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
  labels = model.getClassLabels();
  buildBars();

  els.status.textContent = "Waiting for camera permission…";
  webcam = new tmPose.Webcam(200, 200, true);
  await webcam.setup();
  await webcam.play();

  // Audio must be created from a user gesture
  audio = new (window.AudioContext || window.webkitAudioContext)();
  master = audio.createGain();
  master.gain.value = 0.5;
  master.connect(audio.destination);
  noiseBuffer = makeNoise();

  requestAnimationFrame(loop);
}

function buildBars() {
  els.bars.innerHTML = labels
    .map((l) => `<div class="bar" data-cls="${l}"><span>${l}</span><div class="bar-track"><div class="bar-fill"></div></div></div>`)
    .join("");
}

// ---------- Main loop ----------

async function loop() {
  webcam.update();
  const { pose, posenetOutput } = await model.estimatePose(webcam.canvas);
  const prediction = await model.predict(posenetOutput);

  drawCam(pose);
  updateBars(prediction);
  updateRooster(prediction);
  if (state === "playing") tick(prediction);

  requestAnimationFrame(loop);
}

function drawCam(pose) {
  ctx.drawImage(webcam.canvas, 0, 0);
  if (pose) {
    tmPose.drawKeypoints(pose.keypoints, 0.5, ctx);
    tmPose.drawSkeleton(pose.keypoints, 0.5, ctx);
  }
}

function updateBars(prediction) {
  prediction.forEach((p, i) => {
    els.bars.children[i].querySelector(".bar-fill").style.width = (p.probability * 100).toFixed(0) + "%";
  });
}

// The rooster shows what the model thinks you're doing
function updateRooster(prediction) {
  const top = prediction.reduce((a, b) => (b.probability > a.probability ? b : a));
  const pose = top.className !== "Idle" && top.probability >= 0.6 ? top.className.toLowerCase() : "idle";
  if (els.rooster.dataset.pose !== pose) els.rooster.dataset.pose = pose;
}

function probabilityOf(prediction, className) {
  const p = prediction.find((x) => x.className === className);
  return p ? p.probability : 0;
}

// ---------- Timeline ----------

function buildTimeline() {
  const events = [];
  let t = LEAD_IN;
  ROUNDS.forEach((r, round) => {
    const beat = 60 / r.bpm;
    events.push({ type: "count", start: t, dur: 4 * beat, beat, round });
    t += 4 * beat;
    for (let c = 0; c < CYCLES_PER_ROUND; c++) {
      for (const move of MOVES) {
        const dur = BEATS_PER_MOVE * beat;
        events.push({ type: "move", move, start: t, dur, beat, round, frames: 0, hits: 0, judged: false });
        t += dur;
      }
    }
  });
  return { events, end: t };
}

function buildCueCards() {
  els.cues.innerHTML = "";
  for (const e of timeline.events) {
    if (e.type !== "move") continue;
    const card = document.createElement("div");
    card.className = "cue";
    card.dataset.move = e.move;
    card.style.width = e.dur * PX_PER_SEC - 6 + "px";
    card.textContent = e.move;
    els.cues.appendChild(card);
    e.card = card;
  }
}

function renderCues(t) {
  const hitX = els.cues.clientWidth * 0.18;
  for (const e of timeline.events) {
    if (!e.card) continue;
    const x = hitX + (e.start - t) * PX_PER_SEC;
    e.card.style.transform = `translateX(${x}px)`;
  }
}

// ---------- Game ----------

function startGame() {
  game = { score: 0, combo: 0, best: 0, interest: 40, perfect: 0, good: 0, miss: 0 };
  timeline = buildTimeline();
  buildCueCards();
  els.henWrap.classList.remove("leaving", "won");
  setMood("neutral");
  renderHud();

  if (audio.state === "suspended") audio.resume();
  audioStart = audio.currentTime + 0.1;
  scheduleMusic();

  els.overlay.classList.add("hidden");
  state = "playing";
}

function tick(prediction) {
  const t = audio.currentTime - audioStart;
  renderCues(t);

  const current = timeline.events.find((e) => t >= e.start && t < e.start + e.dur);
  renderMoveLabel(current, t);

  for (const e of timeline.events) {
    if (e.type !== "move" || e.judged) continue;
    // Ignore the first part of each window so you have time to switch moves
    const grace = Math.min(0.35, e.beat * 0.6);
    if (t >= e.start + grace && t < e.start + e.dur) {
      e.frames++;
      if (probabilityOf(prediction, e.move) >= CONFIDENCE) e.hits++;
    } else if (t >= e.start + e.dur) {
      judge(e);
    }
  }

  if (t >= timeline.end + 0.5) endGame();
}

function renderMoveLabel(e, t) {
  if (!e) {
    els.moveName.textContent = "";
    els.beatDots.innerHTML = "";
    return;
  }
  const beatIndex = Math.floor((t - e.start) / e.beat);
  if (e.type === "count") {
    els.round.textContent = e.round + 1;
    els.moveName.textContent = e.round === 0 ? 4 - beatIndex : beatIndex < 2 ? "Faster!" : 4 - beatIndex;
    els.beatDots.innerHTML = "";
  } else {
    els.moveName.textContent = e.move;
    els.beatDots.innerHTML = Array.from({ length: BEATS_PER_MOVE }, (_, i) => `<span class="${i <= beatIndex ? "on" : ""}"></span>`).join("");
  }
}

function judge(e) {
  e.judged = true;
  const ratio = e.frames ? e.hits / e.frames : 0;
  const result = ratio >= PERFECT_RATIO ? "perfect" : ratio >= GOOD_RATIO ? "good" : "miss";
  e.card.classList.add(result);
  game[result]++;

  if (result === "miss") {
    game.combo = 0;
    game.interest -= 7;
    setMood("annoyed");
    setTimeout(restMood, 700);
  } else {
    game.combo++;
    game.best = Math.max(game.best, game.combo);
    const base = result === "perfect" ? 100 : 50;
    game.score += base * (1 + Math.floor(game.combo / 4));
    game.interest += result === "perfect" ? 9 : 4;
    setMood(result === "perfect" ? "smitten" : "interested");
    if (result === "perfect") {
      spawnHearts(3);
      chirp(audio.currentTime);
    }
    setTimeout(restMood, 900);
  }
  game.interest = Math.max(0, Math.min(100, game.interest));
  showRating(result);
  renderHud();
}

function renderHud() {
  els.score.textContent = game.score;
  els.combo.textContent = game.combo;
  els.affection.style.width = game.interest + "%";
  document.documentElement.style.setProperty("--near", (game.interest / 100).toFixed(2));
  document.documentElement.style.setProperty("--glow", Math.min(game.combo / 8, 1).toFixed(2));
}

function showRating(result) {
  els.rating.className = "rating";
  void els.rating.offsetWidth; // restart the animation
  els.rating.textContent = { perfect: "PERFECT!", good: "GOOD", miss: "MISS" }[result];
  els.rating.classList.add("show", result);
}

function setMood(mood) {
  els.hen.dataset.mood = mood;
}

// Her resting mood follows how interested she is overall
function restMood() {
  if (state !== "playing") return;
  setMood(game.interest >= WIN_INTEREST ? "interested" : "neutral");
}

function spawnHearts(n) {
  for (let i = 0; i < n; i++) {
    const h = document.createElement("span");
    h.className = "heart";
    h.textContent = "❤";
    h.style.color = "#ff4fa3";
    h.style.setProperty("--dx", (Math.random() * 60 - 30).toFixed(0) + "px");
    h.style.animationDelay = i * 0.15 + "s";
    els.henWrap.appendChild(h);
    setTimeout(() => h.remove(), 1800);
  }
}

function endGame() {
  state = "done";
  els.moveName.textContent = "";
  els.beatDots.innerHTML = "";
  const won = game.interest >= WIN_INTEREST;
  if (won) {
    setMood("accept");
    els.henWrap.classList.add("won");
    spawnHearts(6);
  } else {
    setMood("neutral");
    els.henWrap.classList.add("leaving");
  }

  setTimeout(() => {
    els.overlay.querySelector(".card").innerHTML = `
      <h1>${won ? "She's charmed!" : "She wandered off…"}</h1>
      <p class="lede">${won ? "Your display won her over. Time to build a nest." : "Your display didn't impress her this time."}</p>
      <div class="stats">
        <span>Score ${game.score}</span>
        <span>Best combo ${game.best}</span>
        <span>Interest ${game.interest}%</span>
      </div>
      <p>${game.perfect} perfect · ${game.good} good · ${game.miss} missed</p>
      <button id="again-btn">Strut again</button>`;
    $("again-btn").addEventListener("click", startGame);
    els.overlay.classList.remove("hidden");
  }, 2500);
}

// ---------- Music (synthesized oom-pah) ----------

const CHORDS = {
  Beak: [261.63, 329.63, 392.0],   // C
  Flap: [196.0, 246.94, 293.66],   // G
  Boogie: [196.0, 246.94, 293.66], // G
  Clap: [261.63, 329.63, 392.0],   // C
};

function scheduleMusic() {
  for (const e of timeline.events) {
    const beats = Math.round(e.dur / e.beat);
    for (let i = 0; i < beats; i++) {
      const at = audioStart + e.start + i * e.beat;
      if (e.type === "count") {
        blip(at, i === 3 ? 1320 : 880);
        continue;
      }
      const chord = CHORDS[e.move];
      kick(at);
      hat(at + e.beat / 2);
      if (i % 2 === 0) tone(chord[0] / 2, at, e.beat * 0.8, "triangle", 0.35);
      else chord.forEach((f) => tone(f, at, e.beat * 0.35, "square", 0.05));
      if (e.move === "Clap") clap(at);
    }
  }
}

function tone(freq, at, dur, type, vol) {
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(master);
  o.start(at);
  o.stop(at + dur + 0.02);
}

function kick(at) {
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.frequency.setValueAtTime(150, at);
  o.frequency.exponentialRampToValueAtTime(40, at + 0.12);
  g.gain.setValueAtTime(0.8, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
  o.connect(g).connect(master);
  o.start(at);
  o.stop(at + 0.16);
}

function makeNoise() {
  const buf = audio.createBuffer(1, audio.sampleRate * 0.3, audio.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function noise(at, dur, vol, filterFreq) {
  const src = audio.createBufferSource();
  const f = audio.createBiquadFilter();
  const g = audio.createGain();
  src.buffer = noiseBuffer;
  f.type = "highpass";
  f.frequency.value = filterFreq;
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(master);
  src.start(at);
  src.stop(at + dur);
}

function hat(at) { noise(at, 0.05, 0.15, 7000); }
function clap(at) { noise(at, 0.12, 0.4, 1200); }
function blip(at, freq) { tone(freq, at, 0.08, "sine", 0.4); }

function chirp(at) {
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.frequency.setValueAtTime(900, at);
  o.frequency.exponentialRampToValueAtTime(1600, at + 0.08);
  g.gain.setValueAtTime(0.15, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
  o.connect(g).connect(master);
  o.start(at);
  o.stop(at + 0.13);
}
