// UX-4 — the sign-in scene: a glass fuel drop with fuel moving inside it,
// floating above a dark mirror floor at the edge of a copper horizon, lit like
// a product shot. Real 3D: ray-marched on the graphics chip in one WebGL
// fragment shader (no libraries). Decorative only (aria-hidden).
//   • No WebGL or a shader error → nothing is drawn; the CSS backdrop stays.
//   • Reduced motion → one still frame, no movement.
//   • Hidden tab → stops drawing. Slow machine → fewer pixels (login3dQuality).
import React, { useEffect, useRef } from 'react';
import { adjustScale, bufferSize, dropCentre, dropLift, easeFill, QUALITY } from './login3dQuality';

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uFill;
uniform float uCentre;
uniform float uLift;

const float FLOOR = -1.45;
const vec3 FUEL = vec3(0.88, 0.33, 0.025);
const vec3 KEY = vec3(0.62, 0.72, 0.31);

float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// Inigo Quilez's round cone: a sphere (r1) at the bottom, a small cap (r2) at height h.
float roundCone(vec3 p, float r1, float r2, float h){
  vec2 q = vec2(length(p.xz), p.y);
  float b = (r1 - r2) / h;
  float a = sqrt(1.0 - b * b);
  float k = dot(q, vec2(-b, a));
  if (k < 0.0) return length(q) - r1;
  if (k > a * h) return length(q - vec2(0.0, h)) - r2;
  return dot(q, vec2(a, b)) - r1;
}

vec3 local(vec3 p){
  p.y -= 0.05 * sin(uTime * 0.9);                 // floating
  p.xy = rot(0.05 * sin(uTime * 0.6)) * p.xy;      // gentle sway
  p.zy = rot(0.04 * cos(uTime * 0.5)) * p.zy;
  return p;
}
float drop(vec3 p){ return roundCone(local(p) - vec3(0.0, -0.55, 0.0), 0.78, 0.06, 1.32); }

float level(vec3 q){
  float lv = mix(-1.30, 0.62, uFill);
  return lv + 0.035 * sin(q.x * 3.4 + uTime * 1.5) + 0.025 * sin(q.z * 4.2 - uTime * 1.2) + 0.012 * sin((q.x + q.z) * 9.0 + uTime * 2.3);
}
float fuel(vec3 p){
  vec3 q = local(p);
  return max(drop(p) + 0.055, q.y - level(q));
}

vec3 nDrop(vec3 p){
  vec2 e = vec2(0.0015, 0.0);
  return normalize(vec3(drop(p + e.xyy) - drop(p - e.xyy), drop(p + e.yxy) - drop(p - e.yxy), drop(p + e.yyx) - drop(p - e.yyx)));
}
vec3 nFuel(vec3 p){
  vec2 e = vec2(0.003, 0.0);
  return normalize(vec3(fuel(p + e.xyy) - fuel(p - e.xyy), fuel(p + e.yxy) - fuel(p - e.yxy), fuel(p + e.yyx) - fuel(p - e.yyx)));
}

// The world around the drop: deep space, stars, a copper horizon, and three
// studio light panels that give the glass its reflections.
vec3 env(vec3 rd, float panels){
  vec3 col = mix(vec3(0.010, 0.012, 0.020), vec3(0.004, 0.005, 0.010), smoothstep(0.0, 0.9, rd.y));
  float hz = exp(-abs(rd.y + 0.03) * 13.0);
  col += vec3(0.95, 0.38, 0.10) * hz * 0.32 * (0.55 + 0.45 * smoothstep(-1.0, 1.0, rd.x));
  col += vec3(1.0, 0.62, 0.32) * exp(-abs(rd.y + 0.012) * 110.0) * 0.45;
  if (rd.y > 0.04) {
    vec3 cell = floor(rd * 210.0);
    float h = hash(cell);
    col += step(0.9978, h) * vec3(0.85, 0.9, 1.0) * smoothstep(0.04, 0.35, rd.y) * (0.55 + 0.45 * sin(uTime * 1.7 + h * 60.0));
  }
  float key = smoothstep(0.03, 0.0, abs(rd.x - 0.72) - 0.16) * smoothstep(0.03, 0.0, abs(rd.y - 0.36) - 0.26);
  float rim = smoothstep(0.04, 0.0, abs(rd.x + 0.86) - 0.07) * smoothstep(0.05, 0.0, abs(rd.y - 0.22) - 0.30);
  float top = smoothstep(0.86, 0.97, rd.y);
  col += (vec3(1.0, 0.98, 0.95) * key * 1.7 + vec3(0.95, 0.14, 0.10) * rim * 1.3 + vec3(0.8, 0.85, 1.0) * top * 0.45) * panels;
  return col;
}

// What is seen through the glass: the fuel (lit, glowing) or the world behind.
vec3 inside(vec3 p, vec3 rd, vec3 n){
  vec3 ri = refract(rd, n, 1.0 / 1.45);
  vec3 q = p - n * 0.03;
  float t = 0.0;
  for (int i = 0; i < 48; i++) {
    float d = fuel(q + ri * t);
    if (d < 0.002) {
      vec3 h = q + ri * t;
      vec3 fn = nFuel(h);
      vec3 L = normalize(KEY);
      float dif = max(dot(fn, L), 0.0);
      float edge = pow(1.0 - max(dot(fn, -ri), 0.0), 2.0);
      vec3 c = FUEL * (0.16 + 0.62 * dif) + vec3(1.0, 0.55, 0.12) * edge * 0.55;
      vec3 lq = local(h);
      float surf = smoothstep(0.03, 0.0, abs(lq.y - level(lq)));
      c += vec3(1.0, 0.78, 0.40) * surf * (0.22 + 0.6 * pow(max(dot(reflect(ri, fn), L), 0.0), 24.0));
      c *= 0.88 + 0.22 * sin(lq.x * 11.0 + uTime * 1.9) * sin(lq.z * 9.0 - uTime * 1.4);
      return c;
    }
    t += max(d * 0.8, 0.004);
    if (t > 2.6) break;
  }
  // Empty glass: the dark scene behind, a little brighter where the glass is thick.
  return env(rd, 0.0) * 0.9 + vec3(0.012, 0.014, 0.02);
}

vec3 shadeDrop(vec3 p, vec3 rd){
  vec3 n = nDrop(p);
  vec3 v = -rd;
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 r = reflect(rd, n);
  vec3 col = mix(inside(p, rd, n), env(r, 1.0), fres);
  col += vec3(1.0) * pow(max(dot(r, normalize(KEY)), 0.0), 140.0) * 2.4;
  col += vec3(0.95, 0.16, 0.12) * pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.4 * smoothstep(0.1, -0.9, n.x);
  return col;
}

vec3 shadeFloor(vec3 p, vec3 rd, float dist){
  vec3 col = vec3(0.006, 0.007, 0.011);
  float r = length(p.xz);
  col += vec3(0.05, 0.055, 0.07) * exp(-r * 0.9);                       // soft spotlight
  col += FUEL * 0.14 * exp(-r * 1.9) * uFill;                            // glow from the fuel
  vec3 rr = reflect(rd, vec3(0.0, 1.0, 0.0));
  float t = 0.02;
  vec3 refl = env(rr, 1.0) * 0.10;
  for (int i = 0; i < 40; i++) {
    float d = drop(p + rr * t);
    if (d < 0.003) { refl = shadeDrop(p + rr * t, rr) * 0.16; break; }
    t += d;
    if (t > 5.0) break;
  }
  col += refl * exp(-r * 0.35);
  float s = clamp(drop(p) / 0.9, 0.0, 1.0);                               // contact shadow
  col *= 0.35 + 0.65 * s;
  return mix(col, env(rd, 1.0), smoothstep(5.0, 14.0, dist));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  uv.x -= (uCentre - 0.5) * uRes.x / uRes.y;
  uv.y -= uLift;
  float a = 0.22 * sin(uTime * 0.11) + uMouse.x * 0.30;
  vec3 ro = vec3(6.6 * sin(a), 0.35 + uMouse.y * 0.35, 6.6 * cos(a));
  vec3 ta = vec3(0.0, -0.42, 0.0);
  vec3 ww = normalize(ta - ro);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.75 * ww);

  float tf = rd.y < 0.0 ? (FLOOR - ro.y) / rd.y : 1e5;
  float t = 0.0; bool hit = false;
  for (int i = 0; i < 90; i++) {
    float d = drop(ro + rd * t);
    if (d < 0.0012) { hit = true; break; }
    t += d;
    if (t > 9.0 || t > tf) break;
  }
  vec3 col;
  if (hit && t < tf) col = shadeDrop(ro + rd * t, rd);
  else if (tf < 1e4) col = shadeFloor(ro + rd * tf, rd, tf);
  else col = env(rd, 1.0);

  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);   // filmic
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  vec2 q = gl_FragCoord.xy / uRes;
  col *= 0.55 + 0.45 * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.18); // vignette
  col += (hash(vec3(gl_FragCoord.xy, uTime)) - 0.5) / 160.0;                  // fine grain
  gl_FragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(log || 'shader'); }
  return s;
}

export default function Login3D({ busy = false }) {
  const canvasRef = useRef(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let gl = null;
    try { gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false }); } catch (_) { gl = null; }
    if (!gl) { canvas.dataset.state = 'fallback'; return undefined; }
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    } catch (e) {
      canvas.dataset.state = 'fallback';
      if (typeof console !== 'undefined') console.warn('[login 3D] off:', e.message); // eslint-disable-line no-console
      return undefined;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(prog, n);
    const uRes = U('uRes'), uTime = U('uTime'), uMouse = U('uMouse'), uFill = U('uFill'), uCentre = U('uCentre'), uLift = U('uLift');

    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let scale = QUALITY.start, fill = still ? 0.55 : 0.0, raf = 0, last = 0, t0 = 0;
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    let frames = [];

    const size = () => {
      const r = canvas.getBoundingClientRect();
      const { w, h } = bufferSize(r.width, r.height, window.devicePixelRatio, scale);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uCentre, dropCentre(r.width));
      gl.uniform1f(uLift, dropLift(r.width));
    };
    const draw = (timeSec) => {
      gl.uniform1f(uTime, timeSec);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform1f(uFill, fill);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const frame = (now) => {
      raf = 0;
      if (!t0) t0 = now;
      const dt = last ? (now - last) / 1000 : 0.016;
      last = now;
      fill = easeFill(fill, busyRef.current ? 0.9 : 0.55, dt);
      mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 3);
      mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 3);
      draw((now - t0) / 1000 + 4);
      frames.push(dt * 1000);
      if (frames.length >= 40) {
        const avg = frames.slice(5).reduce((a, b) => a + b, 0) / (frames.length - 5);
        const next = adjustScale(scale, avg);
        frames = [];
        if (next !== scale) { scale = next; size(); }
      }
      if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!raf && !still && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } };
    const onVis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else start(); };
    const onMove = (e) => {
      const w = window.innerWidth || 1, h = window.innerHeight || 1;
      mouse.tx = (e.clientX / w - 0.5) * 2; mouse.ty = (0.5 - e.clientY / h) * 2;
    };
    const onResize = () => { size(); if (still) draw(6); };

    size();
    if (still) draw(6); else start();
    canvas.dataset.state = 'live';
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    if (!still) window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointermove', onMove);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    };
  }, []);

  return <canvas ref={canvasRef} className="k-l3-canvas" aria-hidden="true" />;
}
