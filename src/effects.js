// Entry-effect renderers for the preview. The real transitions run in the controller firmware, so
// these are faithful-in-spirit approximations keyed by the same <action> numbers PowerLED stores.
//
// drawEntry(ctx, W, H, action, p, prev, next)
//   p      progress 0..1 (p === 1 must reproduce `next` exactly)
//   prev   canvas W x H holding what the window showed before (never null)
//   next   canvas W x H holding the incoming page

export const A = {
  RANDOM: 0, DIRECT: 1, HOLD: 2, MOVE_LEFT_CONT: 3, MOVE_LEFT: 4, MOVE_RIGHT_CONT: 5, MOVE_RIGHT: 6,
  MOVE_UP: 7, MOVE_DOWN: 8, WEAR: 9, RAIN: 10, FOUNTAIN: 11, FLASH: 12, REV_FLASH: 13, SCROLL_OPEN: 14,
  SCROLL_CLOSE: 15, LASER_L: 16, LASER_R: 17, LASER_T: 18, LASER_B: 19, STRETCH_L: 20, STRETCH_R: 21,
  STRETCH_T: 22, STRETCH_B: 23, FROM_LL: 24, FROM_UL: 25, FROM_LR: 26, FROM_UR: 27, COVER_L: 28, COVER_R: 29,
  COVER_T: 30, COVER_B: 31, H_OPEN: 32, H_CLOSE: 33, V_OPEN: 34, V_CLOSE: 35, H_SHUTTER: 36, V_SHUTTER: 37,
  V_CROSS_MOVE: 38, H_CROSS_MOVE: 39, V_CROSS_OPEN: 40, H_CROSS_OPEN: 41, MOSAIC: 42, DIAMOND_OPEN: 43,
  DIAMOND_CLOSE: 44, FALL: 45, TIPSY: 46,
};

export const CONTINUOUS = new Set([A.MOVE_LEFT_CONT, A.MOVE_RIGHT_CONT]);
const RANDOMISABLE = Object.values(A).filter((a) => a >= A.MOVE_LEFT && !CONTINUOUS.has(a));

export function pickRandomAction(rng = Math.random) {
  return RANDOMISABLE[Math.floor(rng() * RANDOMISABLE.length)];
}

// Cheap deterministic hash in [0,1) so effects are stable frame to frame.
function hash(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function clipRect(ctx, img, x, y, w, h) {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function slice(ctx, img, sx, sy, sw, sh, dx, dy) {
  if (sw <= 0 || sh <= 0) return;
  ctx.drawImage(img, sx, sy, sw, sh, Math.round(dx), Math.round(dy), sw, sh);
}

// Transition duration in ms for the non-continuous effects.
export function entryDuration(action, W, H, stepMs) {
  if (action === A.DIRECT || action === A.HOLD) return 0;
  return Math.min(4000, Math.max(250, Math.max(W, H) * stepMs));
}

export function drawEntry(ctx, W, H, action, p, prev, next) {
  p = clamp01(p);
  const R = Math.round;
  if (p >= 1 || action === A.DIRECT || action === A.HOLD) {
    ctx.drawImage(next, 0, 0);
    return;
  }
  const keepPrev = () => ctx.drawImage(prev, 0, 0);

  switch (action) {
    case A.MOVE_LEFT: case A.MOVE_RIGHT: {
      const s = action === A.MOVE_LEFT ? -1 : 1;
      ctx.drawImage(prev, R(s * p * W), 0);
      ctx.drawImage(next, R(s * (p * W - W)), 0);
      break;
    }
    case A.MOVE_UP: case A.MOVE_DOWN: {
      const s = action === A.MOVE_UP ? -1 : 1;
      ctx.drawImage(prev, 0, R(s * p * H));
      ctx.drawImage(next, 0, R(s * (p * H - H)));
      break;
    }
    case A.COVER_L: keepPrev(); ctx.drawImage(next, R(-(1 - p) * W), 0); break;
    case A.COVER_R: keepPrev(); ctx.drawImage(next, R((1 - p) * W), 0); break;
    case A.COVER_T: keepPrev(); ctx.drawImage(next, 0, R(-(1 - p) * H)); break;
    case A.COVER_B: keepPrev(); ctx.drawImage(next, 0, R((1 - p) * H)); break;

    case A.FLASH: case A.REV_FLASH: {
      const on = Math.floor(p * 8) % 2 === 1;
      if (on) {
        if (action === A.REV_FLASH) {
          ctx.filter = 'invert(1)';
          ctx.drawImage(next, 0, 0);
          ctx.filter = 'none';
        } else ctx.drawImage(next, 0, 0);
      }
      break;
    }

    case A.WEAR: case A.MOSAIC: {
      keepPrev();
      const b = action === A.WEAR ? 1 : 4;
      for (let y = 0; y < H; y += b) {
        for (let x = 0; x < W; x += b) {
          if (hash(x * 7919 + y * 104729 + b) < p) slice(ctx, next, x, y, Math.min(b, W - x), Math.min(b, H - y), x, y);
        }
      }
      break;
    }

    case A.RAIN: case A.FOUNTAIN: {
      const dir = action === A.RAIN ? -1 : 1;
      for (let x = 0; x < W; x++) {
        const q = clamp01((p - hash(x + 17) * 0.5) / 0.5);
        slice(ctx, next, x, 0, 1, H, x, dir * (1 - q) * H);
      }
      break;
    }
    case A.FALL: {
      for (let y = 0; y < H; y++) {
        const q = clamp01((p - (y / H) * 0.5) / 0.5);
        slice(ctx, next, 0, y, W, 1, 0, y - (1 - q) * H);
      }
      break;
    }

    case A.SCROLL_OPEN: case A.H_OPEN: keepPrev(); clipRect(ctx, next, R((W - p * W) / 2), 0, R(p * W), H); break;
    case A.V_OPEN: keepPrev(); clipRect(ctx, next, 0, R((H - p * H) / 2), W, R(p * H)); break;
    case A.SCROLL_CLOSE: case A.H_CLOSE:
      keepPrev();
      clipRect(ctx, next, 0, 0, R(p * W / 2), H);
      clipRect(ctx, next, W - R(p * W / 2), 0, R(p * W / 2), H);
      break;
    case A.V_CLOSE:
      keepPrev();
      clipRect(ctx, next, 0, 0, W, R(p * H / 2));
      clipRect(ctx, next, 0, H - R(p * H / 2), W, R(p * H / 2));
      break;

    case A.LASER_L: case A.LASER_R: case A.LASER_T: case A.LASER_B: {
      keepPrev();
      const horiz = action === A.LASER_L || action === A.LASER_R;
      const fromFar = action === A.LASER_R || action === A.LASER_B;
      const len = horiz ? W : H;
      const edge = R(p * len);
      if (horiz) clipRect(ctx, next, fromFar ? W - edge : 0, 0, edge, H);
      else clipRect(ctx, next, 0, fromFar ? H - edge : 0, W, edge);
      ctx.fillStyle = '#fff';
      const lx = fromFar ? W - edge : edge - 1;
      if (horiz) ctx.fillRect(lx, 0, 1, H);
      else ctx.fillRect(0, fromFar ? H - edge : edge - 1, W, 1);
      break;
    }

    case A.STRETCH_L: keepPrev(); ctx.drawImage(next, 0, 0, W, H, 0, 0, Math.max(1, R(p * W)), H); break;
    case A.STRETCH_R: keepPrev(); ctx.drawImage(next, 0, 0, W, H, W - Math.max(1, R(p * W)), 0, Math.max(1, R(p * W)), H); break;
    case A.STRETCH_T: keepPrev(); ctx.drawImage(next, 0, 0, W, H, 0, 0, W, Math.max(1, R(p * H))); break;
    case A.STRETCH_B: keepPrev(); ctx.drawImage(next, 0, 0, W, H, 0, H - Math.max(1, R(p * H)), W, Math.max(1, R(p * H))); break;
    case A.FROM_LL: case A.FROM_UL: case A.FROM_LR: case A.FROM_UR: {
      keepPrev();
      const w = Math.max(1, R(p * W));
      const h = Math.max(1, R(p * H));
      const right = action === A.FROM_LR || action === A.FROM_UR;
      const bottom = action === A.FROM_LL || action === A.FROM_LR;
      ctx.drawImage(next, 0, 0, W, H, right ? W - w : 0, bottom ? H - h : 0, w, h);
      break;
    }

    case A.H_SHUTTER: case A.V_SHUTTER: {
      keepPrev();
      const slat = 4;
      const horizontalSlats = action === A.H_SHUTTER;
      const len = horizontalSlats ? H : W;
      for (let o = 0; o < len; o += slat) {
        const part = Math.max(1, R(p * slat));
        if (horizontalSlats) clipRect(ctx, next, 0, o, W, part);
        else clipRect(ctx, next, o, 0, part, H);
      }
      break;
    }

    case A.V_CROSS_MOVE: case A.H_CROSS_MOVE: {
      const w = 4;
      if (action === A.V_CROSS_MOVE) {
        for (let x = 0; x < W; x += w) slice(ctx, next, x, 0, Math.min(w, W - x), H, x, ((x / w) % 2 ? 1 : -1) * (1 - p) * H);
      } else {
        for (let y = 0; y < H; y += w) slice(ctx, next, 0, y, W, Math.min(w, H - y), ((y / w) % 2 ? 1 : -1) * (1 - p) * W, y);
      }
      break;
    }
    case A.V_CROSS_OPEN: case A.H_CROSS_OPEN: {
      keepPrev();
      const w = 4;
      if (action === A.V_CROSS_OPEN) {
        for (let x = 0; x < W; x += w) {
          const h = R(p * H);
          clipRect(ctx, next, x, (x / w) % 2 ? H - h : 0, Math.min(w, W - x), h);
        }
      } else {
        for (let y = 0; y < H; y += w) {
          const wd = R(p * W);
          clipRect(ctx, next, (y / w) % 2 ? W - wd : 0, y, wd, Math.min(w, H - y));
        }
      }
      break;
    }

    case A.DIAMOND_OPEN: case A.DIAMOND_CLOSE: {
      keepPrev();
      const cx = W / 2, cy = H / 2;
      const grow = action === A.DIAMOND_OPEN;
      const a = (grow ? p : 1 - p) * W;
      const b = (grow ? p : 1 - p) * H;
      ctx.save();
      ctx.beginPath();
      if (!grow) ctx.rect(0, 0, W, H);
      ctx.moveTo(cx - a, cy);
      ctx.lineTo(cx, cy - b);
      ctx.lineTo(cx + a, cy);
      ctx.lineTo(cx, cy + b);
      ctx.closePath();
      ctx.clip(grow ? 'nonzero' : 'evenodd');
      ctx.drawImage(next, 0, 0);
      ctx.restore();
      break;
    }

    case A.TIPSY: {
      const off = (1 - p) * W;
      const wob = Math.sin(p * 14) * (1 - p) * (H / 3);
      ctx.drawImage(next, R(off), R(wob));
      break;
    }

    default:
      ctx.drawImage(next, 0, 0);
  }
}
