const RAD = Math.PI / 180;
const scrn = document.getElementById("canvas");
const sctx = scrn.getContext("2d");
scrn.tabIndex = 1;

// ── Control Mode ──────────────────────────────────────────────────────────────
// "normal" = click/keyboard (no sound feedback)
// "normal-sound" = click/keyboard (with sound feedback)
// "mouth" = WebSocket face tracking - mouth open (with sound feedback)
// "eyebrow" = WebSocket face tracking - eyebrow raise (no sound feedback)
let controlMode = "normal"; // updated by UI toggle

// ── WebSocket (mouth control) ─────────────────────────────────────────────────
let ws = null;
let wsConnected = false;
let wsStatusEl = null;

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket("ws://localhost:8765");

  ws.onopen = () => {
    wsConnected = true;
    updateWsStatus("connected");
    console.log("[WS] Connected to face tracking server");
  };

  ws.onmessage = (event) => {
    if (controlMode !== "mouth" && controlMode !== "eyebrow") return;
    try {
      const msg = JSON.parse(event.data);
      // Fire on mouth-open ("click" message from server) in mouth mode
      if (controlMode === "mouth" && msg.type === "click") {
        triggerAction();
      }
      // Fire on eyebrow-raise ("eyebrow" message from server) in eyebrow mode
      if (controlMode === "eyebrow" && msg.type === "eyebrow") {
        triggerAction();
      }
    } catch (e) {
      console.warn("[WS] Bad message:", event.data);
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    updateWsStatus("disconnected");
    console.log("[WS] Disconnected – retrying in 2s…");
    if (controlMode === "mouth" || controlMode === "eyebrow") {
      setTimeout(connectWebSocket, 2000);
    }
  };

  ws.onerror = () => {
    updateWsStatus("error");
    ws.close();
  };
}

function disconnectWebSocket() {
  if (ws) {
    ws.onclose = null; // prevent auto-reconnect
    ws.close();
    ws = null;
    wsConnected = false;
    updateWsStatus("disconnected");
  }
}

function updateWsStatus(status) {
  if (!wsStatusEl) wsStatusEl = document.getElementById("wsStatus");
  if (!wsStatusEl) return;
  const dot = wsStatusEl.querySelector(".ws-dot");
  const label = wsStatusEl.querySelector(".ws-label");
  if (!dot || !label) return;

  dot.className = "ws-dot";
  switch (status) {
    case "connected":
      dot.classList.add("ws-connected");
      label.textContent = "Face tracker: connected";
      break;
    case "disconnected":
      dot.classList.add("ws-disconnected");
      label.textContent = "Face tracker: disconnected";
      break;
    case "error":
      dot.classList.add("ws-error");
      label.textContent = "Face tracker: error";
      break;
    default:
      label.textContent = "Face tracker: …";
  }
}

// ── Mode toggle (called from HTML buttons) ────────────────────────────────────
function setControlMode(mode) {
  controlMode = mode;

  const btnNormal = document.getElementById("btnNormal");
  const btnNormalSound = document.getElementById("btnNormalSound");
  const btnMouth  = document.getElementById("btnMouth");
  const btnEyebrow = document.getElementById("btnEyebrow");
  const wsStatusEl = document.getElementById("wsStatus");

  if (btnNormal) btnNormal.classList.toggle("active", mode === "normal");
  if (btnNormalSound) btnNormalSound.classList.toggle("active", mode === "normal-sound");
  if (btnMouth)  btnMouth.classList.toggle("active",  mode === "mouth");
  if (btnEyebrow) btnEyebrow.classList.toggle("active", mode === "eyebrow");
  if (wsStatusEl) wsStatusEl.style.display = (mode === "mouth" || mode === "eyebrow") ? "flex" : "none";

  if (mode === "mouth" || mode === "eyebrow") {
    connectWebSocket();
    // Refocus canvas so keyboard still works as fallback
    scrn.focus();
  } else {
    disconnectWebSocket();
    scrn.focus();
  }
}

// ── Click / key input (normal modes) ──────────────────────────────────────────
scrn.addEventListener("click", () => {
  if (controlMode === "mouth" || controlMode === "eyebrow") return;  // only respond in normal/normal-sound modes
  triggerAction();
});

scrn.onkeydown = function keyDown(e) {
  if (e.keyCode == 32 || e.keyCode == 87 || e.keyCode == 38) {
    // Space / W / Arrow-up — works in both modes as fallback
    triggerAction();
  }
};

function triggerAction() {
  // Only use audio feedback in "normal-sound" and "mouth" modes
  const useAudioFeedback = (controlMode === "normal-sound" || controlMode === "mouth");
  
  switch (state.curr) {
    case state.getReady:
      state.curr = state.Play;
      SFX.start.play();
      if (useAudioFeedback) {
        AudioFeedback.start();   // begin proximity tone
      }
      break;
    case state.Play:
      bird.flap();
      break;
    case state.gameOver:
      state.curr = state.getReady;
      bird.speed = 0;
      bird.y = 100;
      pipe.pipes = [];
      UI.score.curr = 0;
      SFX.played = false;
      if (useAudioFeedback) {
        AudioFeedback.stop();    // silence tone on restart
      }
      break;
  }
}

// ── Accessibility: Proximity Sound Feedback ───────────────────────────────────
//
// Plays a continuous synthesised tone throughout gameplay.
// Pitch encodes the bird's vertical position relative to the pipe gap:
//
//   Bird ABOVE gap centre → HIGH pitch (330 → 900 Hz as it nears the top pipe)
//   Bird at gap centre    → neutral mid tone ~330 Hz
//   Bird BELOW gap centre → LOW pitch  (330 → 80 Hz  as it nears the bottom pipe)
//
// The gradient is smooth and continuous — pitch rises as the bird floats up,
// drops as it falls. A blind player can hear exactly which direction to flap.
// No audio files needed — fully synthesised via Web Audio API.

const AudioFeedback = (() => {
  let ctx     = null;   // AudioContext (lazy-created on first user gesture)
  let osc     = null;   // OscillatorNode
  let gain    = null;   // GainNode (master volume)
  let running = false;

  const FREQ_LOW    = 150;   // Hz – bird far below gap centre (about to hit floor pipe)
  const FREQ_SAFE   = 330;   // Hz – bird at gap centre (neutral)
  const FREQ_DANGER = 900;   // Hz – bird far above gap centre (about to hit top pipe)
  const GLIDE       = 0.07;  // seconds for pitch to glide to new target

  function _init() {
    if (ctx) return;
    ctx  = new (window.AudioContext || window.webkitAudioContext)();
    gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.connect(ctx.destination);
    osc  = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(FREQ_SAFE, ctx.currentTime);
    osc.connect(gain);
    osc.start();
  }

  // Call once when Play begins (resumes AudioContext if suspended)
  function start() {
    _init();
    if (ctx.state === "suspended") ctx.resume();
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.45, ctx.currentTime + 0.08);
    running = true;
  }

  // Fade out and silence when not playing
  function stop() {
    if (!ctx || !running) return;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);
    running = false;
  }

  // Called every frame during Play.
  //   birdY  – bird centre Y (px)
  //   birdR  – bird collision radius (px)
  //   roof   – bottom edge of top pipe (px)  ← smaller Y value (higher on screen)
  //   floor  – top edge of bottom pipe (px)  ← larger Y value  (lower on screen)
  //   birdX  – bird centre X (px)
  //   pipeX  – left edge of nearest pipe (px)
  //   pipeW  – pipe width (px)
  //
  // Pitch mapping (canvas Y increases downward):
  //   Bird ABOVE gap centre → HIGH pitch (330 → 900 Hz as bird nears top pipe)
  //   Bird BELOW gap centre → LOW pitch  (330 → 80 Hz  as bird nears bot pipe)
  //   Bird at gap centre    → neutral mid tone ~330 Hz
  function update(birdY, birdR, roof, floor, birdX, pipeX, pipeW) {
    if (!ctx || !running) return;

    const gapCentre = (roof + floor) / 2;
    const halfGap   = (floor - roof) / 2;   // gap centre → either edge

    // signed offset: negative = bird is above centre, positive = below centre
    const offset = birdY - gapCentre;

    // normalised 0→1 where 1 = exactly at the pipe edge (or beyond)
    const norm = Math.min(Math.abs(offset) / halfGap, 1.2);

    let targetFreq;
    if (offset < 0) {
      // Bird is ABOVE gap centre → HIGH pitch, scaling up toward danger
      // 0 = centre (330 Hz) … 1 = top pipe edge (900 Hz)
      targetFreq = FREQ_SAFE + (FREQ_DANGER - FREQ_SAFE) * Math.pow(norm, 0.7);
    } else {
      // Bird is BELOW gap centre → LOW pitch, scaling down toward danger
      // 0 = centre (330 Hz) … 1 = bottom pipe edge (80 Hz)
      targetFreq = FREQ_SAFE - (FREQ_SAFE - FREQ_LOW) * Math.pow(norm, 0.7);
    }

    // Clamp to audible range
    targetFreq = Math.max(FREQ_LOW, Math.min(targetFreq, 1100));

    // Smoothly glide to new pitch
    osc.frequency.cancelScheduledValues(ctx.currentTime);
    osc.frequency.setValueAtTime(osc.frequency.value, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(targetFreq, ctx.currentTime + GLIDE);
  }

  return { start, stop, update };
})();

// ── Game state ────────────────────────────────────────────────────────────────
let frames = 0;
let dx = 2;
const state = {
  curr: 0,
  getReady: 0,
  Play: 1,
  gameOver: 2,
};
const SFX = {
  start: new Audio(),
  flap: new Audio(),
  score: new Audio(),
  hit: new Audio(),
  die: new Audio(),
  played: false,
};
const gnd = {
  sprite: new Image(),
  x: 0,
  y: 0,
  draw: function () {
    this.y = parseFloat(scrn.height - this.sprite.height);
    sctx.drawImage(this.sprite, this.x, this.y);
  },
  update: function () {
    if (state.curr != state.Play) return;
    this.x -= dx;
    this.x = this.x % (this.sprite.width / 2);
  },
};
const bg = {
  sprite: new Image(),
  x: 0,
  y: 0,
  draw: function () {
    y = parseFloat(scrn.height - this.sprite.height);
    sctx.drawImage(this.sprite, this.x, y);
  },
};
const pipe = {
  top: { sprite: new Image() },
  bot: { sprite: new Image() },
  gap: 85,
  moved: true,
  pipes: [],
  draw: function () {
    for (let i = 0; i < this.pipes.length; i++) {
      let p = this.pipes[i];
      sctx.drawImage(this.top.sprite, p.x, p.y);
      sctx.drawImage(
        this.bot.sprite,
        p.x,
        p.y + parseFloat(this.top.sprite.height) + this.gap
      );
    }
  },
  update: function () {
    if (state.curr != state.Play) return;
    if (frames % 100 == 0) {
      this.pipes.push({
        x: parseFloat(scrn.width),
        y: -210 * Math.min(Math.random() + 1, 1.8),
      });
    }
    this.pipes.forEach((pipe) => {
      pipe.x -= dx;
    });

    if (this.pipes.length && this.pipes[0].x < -this.top.sprite.width) {
      this.pipes.shift();
      this.moved = true;
    }
  },
};
const bird = {
  animations: [
    { sprite: new Image() },
    { sprite: new Image() },
    { sprite: new Image() },
    { sprite: new Image() },
  ],
  rotatation: 0,
  x: 50,
  y: 100,
  speed: 0,
  gravity: 0.125,
  thrust: 3.6,
  frame: 0,
  draw: function () {
    let h = this.animations[this.frame].sprite.height;
    let w = this.animations[this.frame].sprite.width;
    sctx.save();
    sctx.translate(this.x, this.y);
    sctx.rotate(this.rotatation * RAD);
    sctx.drawImage(this.animations[this.frame].sprite, -w / 2, -h / 2);
    sctx.restore();
  },
  update: function () {
    let r = parseFloat(this.animations[0].sprite.width) / 2;
    switch (state.curr) {
      case state.getReady:
        this.rotatation = 0;
        this.y += frames % 10 == 0 ? Math.sin(frames * RAD) : 0;
        this.frame += frames % 10 == 0 ? 1 : 0;
        break;
      case state.Play:
        this.frame += frames % 5 == 0 ? 1 : 0;
        this.y += this.speed;
        this.setRotation();
        this.speed += this.gravity;
        if (this.y + r >= gnd.y || this.collisioned()) {
          state.curr = state.gameOver;
          // Only stop audio feedback if it's enabled
          if (controlMode === "normal-sound" || controlMode === "mouth") {
            AudioFeedback.stop();   // silence proximity tone on death
          }
        }
        break;
      case state.gameOver:
        this.frame = 1;
        if (this.y + r < gnd.y) {
          this.y += this.speed;
          this.setRotation();
          this.speed += this.gravity * 2;
        } else {
          this.speed = 0;
          this.y = gnd.y - r;
          this.rotatation = 90;
          if (!SFX.played) {
            SFX.die.play();
            SFX.played = true;
          }
        }
        break;
    }
    this.frame = this.frame % this.animations.length;
  },
  flap: function () {
    if (this.y > 0) {
      SFX.flap.play();
      this.speed = -this.thrust;
    }
  },
  setRotation: function () {
    if (this.speed <= 0) {
      this.rotatation = Math.max(-25, (-25 * this.speed) / (-1 * this.thrust));
    } else if (this.speed > 0) {
      this.rotatation = Math.min(90, (90 * this.speed) / (this.thrust * 2));
    }
  },
  collisioned: function () {
    if (!pipe.pipes.length) return;
    let bird = this.animations[0].sprite;
    let x = pipe.pipes[0].x;
    let y = pipe.pipes[0].y;
    let r = bird.height / 4 + bird.width / 4;
    let roof = y + parseFloat(pipe.top.sprite.height);
    let floor = roof + pipe.gap;
    let w = parseFloat(pipe.top.sprite.width);
    if (this.x + r >= x) {
      if (this.x + r < x + w) {
        if (this.y - r <= roof || this.y + r >= floor) {
          SFX.hit.play();
          return true;
        }
      } else if (pipe.moved) {
        UI.score.curr++;
        SFX.score.play();
        pipe.moved = false;
      }
    }
  },
};
const UI = {
  getReady: { sprite: new Image() },
  gameOver: { sprite: new Image() },
  tap: [{ sprite: new Image() }, { sprite: new Image() }],
  score: {
    curr: 0,
    best: 0,
  },
  x: 0,
  y: 0,
  tx: 0,
  ty: 0,
  frame: 0,
  draw: function () {
    switch (state.curr) {
      case state.getReady:
        this.y = parseFloat(scrn.height - this.getReady.sprite.height) / 2;
        this.x = parseFloat(scrn.width - this.getReady.sprite.width) / 2;
        this.tx = parseFloat(scrn.width - this.tap[0].sprite.width) / 2;
        this.ty =
          this.y + this.getReady.sprite.height - this.tap[0].sprite.height;
        sctx.drawImage(this.getReady.sprite, this.x, this.y);
        sctx.drawImage(this.tap[this.frame].sprite, this.tx, this.ty);
        break;
      case state.gameOver:
        this.y = parseFloat(scrn.height - this.gameOver.sprite.height) / 2;
        this.x = parseFloat(scrn.width - this.gameOver.sprite.width) / 2;
        this.tx = parseFloat(scrn.width - this.tap[0].sprite.width) / 2;
        this.ty =
          this.y + this.gameOver.sprite.height - this.tap[0].sprite.height;
        sctx.drawImage(this.gameOver.sprite, this.x, this.y);
        sctx.drawImage(this.tap[this.frame].sprite, this.tx, this.ty);
        break;
    }
    this.drawScore();
  },
  drawScore: function () {
    sctx.fillStyle = "#FFFFFF";
    sctx.strokeStyle = "#000000";
    switch (state.curr) {
      case state.Play:
        sctx.lineWidth = "2";
        sctx.font = "35px Squada One";
        sctx.fillText(this.score.curr, scrn.width / 2 - 5, 50);
        sctx.strokeText(this.score.curr, scrn.width / 2 - 5, 50);
        break;
      case state.gameOver:
        sctx.lineWidth = "2";
        sctx.font = "40px Squada One";
        let sc = `SCORE :     ${this.score.curr}`;
        try {
          this.score.best = Math.max(
            this.score.curr,
            localStorage.getItem("best")
          );
          localStorage.setItem("best", this.score.best);
          let bs = `BEST  :     ${this.score.best}`;
          sctx.fillText(sc, scrn.width / 2 - 80, scrn.height / 2 + 0);
          sctx.strokeText(sc, scrn.width / 2 - 80, scrn.height / 2 + 0);
          sctx.fillText(bs, scrn.width / 2 - 80, scrn.height / 2 + 30);
          sctx.strokeText(bs, scrn.width / 2 - 80, scrn.height / 2 + 30);
        } catch (e) {
          sctx.fillText(sc, scrn.width / 2 - 85, scrn.height / 2 + 15);
          sctx.strokeText(sc, scrn.width / 2 - 85, scrn.height / 2 + 15);
        }
        break;
    }
  },
  update: function () {
    if (state.curr == state.Play) return;
    this.frame += frames % 10 == 0 ? 1 : 0;
    this.frame = this.frame % this.tap.length;
  },
};

gnd.sprite.src = "img/ground.png";
bg.sprite.src = "img/BG.png";
pipe.top.sprite.src = "img/toppipe.png";
pipe.bot.sprite.src = "img/botpipe.png";
UI.gameOver.sprite.src = "img/go.png";
UI.getReady.sprite.src = "img/getready.png";
UI.tap[0].sprite.src = "img/tap/t0.png";
UI.tap[1].sprite.src = "img/tap/t1.png";
bird.animations[0].sprite.src = "img/bird/b0.png";
bird.animations[1].sprite.src = "img/bird/b1.png";
bird.animations[2].sprite.src = "img/bird/b2.png";
bird.animations[3].sprite.src = "img/bird/b0.png";
SFX.start.src = "sfx/start.wav";
SFX.flap.src = "sfx/flap.wav";
SFX.score.src = "sfx/score.wav";
SFX.hit.src = "sfx/hit.wav";
SFX.die.src = "sfx/die.wav";

function gameLoop() {
  update();
  draw();
  frames++;
}

function update() {
  bird.update();
  gnd.update();
  pipe.update();
  UI.update();

  // ── Audio proximity feedback (only in normal-sound and mouth modes) ──────────
  if ((controlMode === "normal-sound" || controlMode === "mouth") && 
      state.curr === state.Play && 
      pipe.pipes.length) {
    const p      = pipe.pipes[0];
    const birdSp = bird.animations[0].sprite;
    const birdR  = (birdSp.height + birdSp.width) / 4;
    const roof   = p.y + parseFloat(pipe.top.sprite.height);
    const floor  = roof + pipe.gap;
    const pipeW  = parseFloat(pipe.top.sprite.width);
    AudioFeedback.update(bird.y, birdR, roof, floor, bird.x, p.x, pipeW);
  }
}

function draw() {
  sctx.fillStyle = "#30c0df";
  sctx.fillRect(0, 0, scrn.width, scrn.height);
  bg.draw();
  pipe.draw();
  bird.draw();
  gnd.draw();
  UI.draw();
}

setInterval(gameLoop, 20);
