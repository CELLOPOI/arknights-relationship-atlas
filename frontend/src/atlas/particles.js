import { createLifecycle } from './lifecycle.js';
import { planEmblemFlight, FLIGHT_GLOW, FORMATION_DURATION } from './emblem-motion.js';

// 先从图像建立目标点，再让粒子的当前位置逐帧追上目标；图片本身不参与主画布绘制。
const VERTEX = `
attribute vec3 a_position;
attribute vec3 a_style;
uniform vec2 u_resolution;
uniform float u_scale;
uniform float u_dpr;
varying float v_alpha;
varying float v_tint;
void main() {
  float perspective = 1.0 / (1.0 + a_position.z * 0.28);
  vec2 pixel = a_position.xy * u_scale * perspective;
  gl_Position = vec4(pixel.x * 2.0 / u_resolution.x, -pixel.y * 2.0 / u_resolution.y, 0.0, 1.0);
  gl_PointSize = a_style.x * u_dpr * perspective;
  v_alpha = a_style.y * clamp(perspective, 0.4, 1.2);
  v_tint = a_style.z;
}`;
const FRAGMENT = `
precision mediump float;
uniform float u_line;
varying float v_alpha;
varying float v_tint;
void main() {
  float distance = length(gl_PointCoord - vec2(0.5));
  float alpha = u_line > 0.5 ? v_alpha : (1.0 - smoothstep(0.18, 0.5, distance)) * v_alpha;
  vec3 color = mix(vec3(0.89, 0.96, 0.93), vec3(0.40, 0.78, 0.74), v_tint);
  gl_FragColor = vec4(color, alpha);
}`;

function randomGenerator(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export async function sampleEmblem(url, count, signal) {
  const image = new Image();
  signal?.throwIfAborted();
  const abort = () => { image.src = ''; };
  signal?.addEventListener('abort', abort, { once: true });
  try { image.src = url; await image.decode(); }
  finally { signal?.removeEventListener('abort', abort); }
  signal?.throwIfAborted();
  const canvas = document.createElement('canvas');
  const ratio = Math.min(512 / image.naturalWidth, 512 / image.naturalHeight, 1);
  const width = canvas.width = Math.round(image.naturalWidth * ratio);
  const height = canvas.height = Math.round(image.naturalHeight * ratio);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  const hasAlpha = transparent > width * height * 0.03;
  // 透明徽记按 alpha 采样；不透明黑白图用边角背景亮度判断前景，避免采出整张方形。
  const background = (data[0] + data[1] + data[2]) / 3;
  const candidates = [];
  const mask = new Uint8Array(width * height);
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luminosity = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
      const foreground = hasAlpha ? data[offset + 3] : background > 128 ? 255 - luminosity : luminosity;
      if (foreground < 100) continue;
      candidates.push(x, y);
      mask[y * width + x] = 1;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (candidates.length < 40) throw new Error('The emblem has no usable foreground pixels.');
  const shapeWidth = right - left + 1, shapeHeight = bottom - top + 1;
  const extent = Math.max(shapeWidth, shapeHeight);
  const random = randomGenerator(candidates.length + width);
  const points = new Float32Array(count * 3);
  const contours = new Uint8Array(count);
  const edgePixels = [], innerPixels = [];
  for (let i = 0; i < candidates.length; i += 2) {
    const x = candidates[i], y = candidates[i + 1];
    const edge = x === 0 || x === width - 1 || y === 0 || y === height - 1 || !mask[y * width + x - 1] || !mask[y * width + x + 1] || !mask[(y - 1) * width + x] || !mask[(y + 1) * width + x];
    (edge ? edgePixels : innerPixels).push(x, y);
  }
  // 轮廓与填充分配独立预算，保留细线；格内选真实前景点，避免把空洞和文字间隙填平。
  const sampleGrid = (pixels, spacing) => {
    const columns = Math.ceil(shapeWidth / spacing), rows = Math.ceil(shapeHeight / spacing);
    const occupied = new Int32Array(columns * rows).fill(-1);
    const distances = new Float32Array(columns * rows).fill(Infinity);
    for (let i = 0; i < pixels.length; i += 2) {
      const x = pixels[i] - left, y = pixels[i + 1] - top;
      const column = Math.floor(x / spacing), row = Math.floor(y / spacing);
      const cell = row * columns + column;
      const distance = (x - (column + .5) * spacing) ** 2 + (y - (row + .5) * spacing) ** 2;
      if (distance < distances[cell]) {
        occupied[cell] = i;
        distances[cell] = distance;
      }
    }
    return occupied.filter(index => index >= 0);
  };
  const sampleLayer = (pixels, budget, offset, edge) => {
    if (!budget) return;
    let low = 1, high = Math.max(2, Math.sqrt(pixels.length / (2 * budget)) * 4);
    let grid = sampleGrid(pixels, low);
    for (let attempt = 0; attempt < 9; attempt++) {
      const spacing = (low + high) / 2;
      const next = sampleGrid(pixels, spacing);
      if (next.length >= budget) { low = spacing; grid = next; }
      else high = spacing;
    }
    for (let i = 0; i < budget; i++) {
      const pixel = grid[Math.floor((i + .5) / budget * grid.length)];
      const j = (offset + i) * 3;
      points[j] = (pixels[pixel] + (random() - .5) * .2 - (left + right) / 2) / extent;
      points[j + 1] = (pixels[pixel + 1] + (random() - .5) * .2 - (top + bottom) / 2) / extent;
      points[j + 2] = (random() - .5) * .006;
      contours[offset + i] = edge ? 1 : 0;
    }
  };
  const edgeBudget = innerPixels.length ? Math.min(edgePixels.length / 2, Math.round(count * .38)) : count;
  sampleLayer(edgePixels, edgeBudget, 0, true);
  sampleLayer(innerPixels, count - edgeBudget, edgeBudget, false);
  // 打乱次序让换图时的轨迹交织，而不是从上到下整排移动。
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    for (let axis = 0; axis < 3; axis++) {
      const temporary = points[i * 3 + axis];
      points[i * 3 + axis] = points[j * 3 + axis];
      points[j * 3 + axis] = temporary;
    }
    const edge = contours[i]; contours[i] = contours[j]; contours[j] = edge;
  }
  const cropped = document.createElement('canvas');
  cropped.width = shapeWidth; cropped.height = shapeHeight;
  cropped.getContext('2d').drawImage(canvas, left, top, shapeWidth, shapeHeight, 0, 0, shapeWidth, shapeHeight);
  return { points, contours, preview: cropped.toDataURL(), aspect: shapeWidth / shapeHeight, foregroundPixels: candidates.length / 2, hasAlpha };
}

export class ParticleField {
  constructor(canvas, { reducedMotion = false, onError = () => {}, interactionTarget = canvas } = {}) {
    this.lifecycle = createLifecycle();
    this.canvas = canvas;
    this.interactionTarget = interactionTarget;
    this.reducedMotion = reducedMotion;
    this.onError = onError;
    const shortLandscape = matchMedia('(max-height: 560px) and (orientation: landscape)').matches;
    const narrowScreen = matchMedia('(max-width: 760px)').matches;
    this.count = shortLandscape ? 1200 : narrowScreen ? 2400 : 5000;
    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.targets = new Float32Array(this.count * 3);
    this.cloud = new Float32Array(this.count * 3);
    this.origins = new Float32Array(this.count * 3);
    this.arrivalDelays = new Float32Array(this.count);
    this.flightDurations = new Float32Array(this.count);
    this.flightControl1 = new Float32Array(this.count * 3);
    this.flightControl2 = new Float32Array(this.count * 3);
    this.formationElapsed = null;
    this.styles = new Float32Array(this.count * 3);
    this.springs = new Float32Array(this.count);
    this.phaseSin = new Float32Array(this.count * 3);
    this.phaseCos = new Float32Array(this.count * 3);
    this.maxLasers = shortLandscape || narrowScreen ? 48 : 96;
    this.laserPositions = new Float32Array(this.maxLasers * 6);
    this.laserStyles = new Float32Array(this.maxLasers * 6);
    this.laserCount = 0;
    this.pointer = { x: 10, y: 10, active: false };
    this.ready = false;
    this.paused = false;
    this.frameCount = 0;
    const random = randomGenerator(142857);
    for (let i = 0; i < this.count; i++) {
      const index = i * 3;
      const angle = random() * Math.PI * 2;
      const radius = 0.14 + Math.sqrt(random()) * 0.69;
      this.cloud[index] = Math.cos(angle) * radius;
      this.cloud[index + 1] = Math.sin(angle) * radius * 0.77;
      this.cloud[index + 2] = (random() - 0.5) * 1.8;
      this.positions.set(this.cloud.subarray(index, index + 3), index);
      this.styles[index] = (shortLandscape || narrowScreen ? 1.6 : 2) + random() * .6;
      this.styles[index + 1] = 0.5 + random() * 0.38;
      this.styles[index + 2] = random() < 0.14 ? 0.8 : random() * 0.12;
      this.springs[i] = 0.012 + random() * 0.012;
      for (let axis = 0; axis < 3; axis++) {
        this.phaseSin[index + axis] = Math.sin(i + axis);
        this.phaseCos[index + axis] = Math.cos(i + axis);
      }
    }
    try { this.initializeRenderer(); } catch (error) { this.dispose(); throw error; }
    if (this.renderer === 'canvas2d') {
      this.count = Math.min(this.count, 2200);
      this.maxLasers = 48;
      for (const name of ['positions', 'velocities', 'targets', 'cloud', 'origins', 'flightControl1', 'flightControl2', 'styles', 'phaseSin', 'phaseCos']) this[name] = this[name].slice(0, this.count * 3);
      this.arrivalDelays = this.arrivalDelays.slice(0, this.count);
      this.flightDurations = this.flightDurations.slice(0, this.count);
      this.springs = this.springs.slice(0, this.count);
    }
    this.baseStyles = this.styles.slice();
    this.initialStyles = this.styles.slice();
    this.laserStride = Math.max(1, Math.ceil(this.count / (this.maxLasers * 4)));
    this.resizeObserver = this.lifecycle.observe(ResizeObserver, canvas, () => this.resize());
    this.bindPointer();
    this.resize();
    this.tick = this.tick.bind(this);
    this.resume();
    this.lifecycle.listen(canvas, 'webglcontextlost', (event) => {
      event.preventDefault();
      this.pause();
      this.onError(new Error('The graphics context was lost. Reload to recover.'));
    });
  }

  initializeRenderer() {
    const gl = this.canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    if (!gl) {
      this.context = this.canvas.getContext('2d');
      if (!this.context) throw new Error('No supported canvas renderer is available.');
      this.renderer = 'canvas2d';
      return;
    }
    this.gl = gl;
    this.renderer = 'webgl';
    const shaders = [];
    this.lifecycle.own(() => {
      if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
      if (this.styleBuffer) gl.deleteBuffer(this.styleBuffer);
      if (this.laserPositionBuffer) gl.deleteBuffer(this.laserPositionBuffer);
      if (this.laserStyleBuffer) gl.deleteBuffer(this.laserStyleBuffer);
      if (this.program) gl.deleteProgram(this.program);
      shaders.forEach(shader => gl.deleteShader(shader));
    });
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX), fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = this.program = gl.createProgram();
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.deleteShader(vertex); gl.deleteShader(fragment); shaders.length = 0; gl.useProgram(program);
    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.DYNAMIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
    this.styleBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.styleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.styles, gl.DYNAMIC_DRAW);
    const style = gl.getAttribLocation(program, 'a_style');
    gl.enableVertexAttribArray(style); gl.vertexAttribPointer(style, 3, gl.FLOAT, false, 0, 0);
    this.attributes = { position, style };
    this.laserPositionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.laserPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.laserPositions, gl.DYNAMIC_DRAW);
    this.laserStyleBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.laserStyleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.laserStyles, gl.DYNAMIC_DRAW);
    this.uniforms = Object.fromEntries(['resolution', 'scale', 'dpr', 'line'].map(name => [name, gl.getUniformLocation(program, `u_${name}`)]));
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
  }

  resize() {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.scale = Math.min(this.width * 0.72, this.height * 0.7);
    this.canvas.parentElement.style.setProperty('--emblem-scale', `${this.scale}px`);
    if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.onResize?.();
    if (this.ready) this.draw();
  }

  bindPointer() {
    const surface = this.interactionTarget;
    const locate = (event) => {
      if (event.target.closest('button, a')) { this.pointer.active = false; return; }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = (event.clientX - rect.left - this.width / 2) / this.scale;
      this.pointer.y = (event.clientY - rect.top - this.height / 2) / this.scale;
      this.pointer.active = !this.reducedMotion;
    };
    this.lifecycle.listen(surface, 'pointerenter', locate);
    this.lifecycle.listen(surface, 'pointermove', locate);
    this.lifecycle.listen(surface, 'pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button, a')) return;
      locate(event);
      if (event.pointerType !== 'mouse') surface.setPointerCapture(event.pointerId);
      if (!this.reducedMotion) this.ripple(this.pointer.x, this.pointer.y);
    });
    const release = () => { this.pointer.active = false; };
    this.lifecycle.listen(surface, 'pointerleave', release);
    this.lifecycle.listen(surface, 'pointercancel', release);
    this.lifecycle.listen(surface, 'pointerup', event => { if (event.pointerType !== 'mouse') release(); });
    this.lifecycle.listen(surface, 'lostpointercapture', release);
    this.lifecycle.listen(window, 'blur', release);
  }

  setEmblem(sample, { id = 'unknown', replay = false } = {}) {
    if (this.sample === sample && this.emblemId === id && !replay) return;
    this.sample = sample;
    this.emblemId = id;
    this.targets.set(sample.points);
    this.baseStyles.set(this.initialStyles);
    for (let i = 0; i < this.count; i++) {
      if (!sample.contours?.[i]) continue;
      this.baseStyles[i * 3] += .15;
      this.baseStyles[i * 3 + 1] = Math.min(1, this.baseStyles[i * 3 + 1] + .18);
    }
    this.ready = true;
    if (this.reducedMotion) { this.snap(); return; }
    const random = randomGenerator(Math.floor(Math.random() * 0x100000000));
    this.motionProfile = planEmblemFlight(this, id, random);
    this.styles.set(this.baseStyles);
    for (let i = 0; i < this.count; i++) this.styles[i * 3 + 1] = 0;
    this.positions.set(this.origins);
    this.velocities.fill(0);
    this.formationElapsed = 0;
    this.laserCount = 0;
    this.stylesDirty = true;
    this.draw();
  }

  setReducedMotion(value) {
    if (this.reducedMotion === value) return;
    this.reducedMotion = value;
    this.pointer.active = false;
    if (value) this.snap();
  }

  snap() {
    this.positions.set(this.targets);
    this.velocities.fill(0);
    this.formationElapsed = null;
    this.styles.set(this.baseStyles);
    this.stylesDirty = true;
    this.laserCount = 0;
    this.draw();
  }

  ripple(x, y) {
    for (let i = 0; i < this.count; i++) {
      const index = i * 3;
      const dx = this.positions[index] - x, dy = this.positions[index + 1] - y;
      const distance = Math.hypot(dx, dy) + 0.001;
      const force = Math.exp(-distance * 3.3) * 0.065;
      this.velocities[index] += dx / distance * force;
      this.velocities[index + 1] += dy / distance * force;
      this.velocities[index + 2] += force * 0.6;
    }
  }

  step(now, dt) {
    const target = this.targets;
    const damping = Math.pow(0.84, dt);
    // 相位固定，按和角公式复用每帧两个三角函数，避免逐点逐轴重复计算。
    const sinTime = Math.sin(now * 0.0006) * 0.00055;
    const cosTime = Math.cos(now * 0.0006) * 0.00055;
    if (this.formationElapsed !== null) {
      this.formationElapsed += dt * 16.667;
      this.stylesDirty = true;
      if (this.formationElapsed >= FORMATION_DURATION) {
        this.formationElapsed = null;
        this.styles.set(this.baseStyles);
      }
    }
    this.laserCount = 0;
    for (let i = 0; i < this.count; i++) {
      const index = i * 3, spring = this.springs[i];
      let flash = 0, ingress = 0, curve1 = 0, curve2 = 0, trail = 0;
      if (this.formationElapsed !== null) {
        const age = this.formationElapsed - this.arrivalDelays[i];
        if (age < 0) continue;
        const duration = this.flightDurations[i];
        const progress = Math.min(1, age / duration);
        const travel = 1 - (1 - progress) * (1 - progress);
        const remaining = 1 - travel;
        ingress = remaining * remaining * remaining;
        curve1 = 3 * remaining * remaining * travel;
        curve2 = 3 * remaining * travel * travel;
        flash = Math.max(0, 1 - Math.abs(age - duration) / FLIGHT_GLOW);
        trail = Math.min(1, age / 75) * Math.max(0, 1 - (age - duration) / FLIGHT_GLOW);
        trail = Math.min(1, trail);
        this.styles[index] = this.baseStyles[index] * (1 + flash * 0.35);
        this.styles[index + 1] = Math.min(1, age / 65) * Math.min(1, this.baseStyles[index + 1] + flash * 0.3);
      }
      for (let axis = 0; axis < 3; axis++) {
        const j = index + axis;
        const drift = sinTime * this.phaseCos[j] + cosTime * this.phaseSin[j];
        const destination = target[j] + (this.origins[j] - target[j]) * ingress + this.flightControl1[j] * curve1 + this.flightControl2[j] * curve2;
        this.velocities[j] = (this.velocities[j] + (destination + drift - this.positions[j]) * spring * dt) * damping;
      }
      if (this.pointer.active) {
        const dx = this.positions[index] - this.pointer.x, dy = this.positions[index + 1] - this.pointer.y;
        const distanceSquared = dx * dx + dy * dy;
        const radius = 0.2;
        if (distanceSquared < radius * radius) {
          const distance = Math.sqrt(distanceSquared) + 0.0001;
          const force = (1 - distance / radius) ** 2 * 0.012 * dt;
          this.velocities[index] += dx / distance * force;
          this.velocities[index + 1] += dy / distance * force;
          this.velocities[index + 2] += force * 0.35;
        }
      }
      for (let axis = 0; axis < 3; axis++) this.positions[index + axis] += this.velocities[index + axis] * dt;
      // 尾迹跟随实际速度，只保留短段，不把起点与落点连成长线网。
      if (trail > 0.03 && i % this.laserStride === 0 && this.laserCount < this.maxLasers) {
        const speed = Math.hypot(this.velocities[index], this.velocities[index + 1], this.velocities[index + 2]);
        if (speed < 0.0002) continue;
        const tail = Math.min(3.4, 0.07 / speed);
        const offset = this.laserCount++ * 6;
        for (let axis = 0; axis < 3; axis++) {
          this.laserPositions[offset + axis] = this.positions[index + axis] - this.velocities[index + axis] * tail;
          this.laserPositions[offset + 3 + axis] = this.positions[index + axis];
        }
        this.laserStyles[offset] = this.laserStyles[offset + 3] = 1;
        this.laserStyles[offset + 1] = 0;
        this.laserStyles[offset + 4] = trail * (0.45 + flash * 0.2);
        this.laserStyles[offset + 2] = this.laserStyles[offset + 5] = 0.65;
      }
    }
  }

  draw() {
    if (!this.ready || !this.width || !this.height) return;
    if (this.gl) {
      const gl = this.gl;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.uniform2f(this.uniforms.resolution, this.width, this.height);
      gl.uniform1f(this.uniforms.scale, this.scale);
      gl.uniform1f(this.uniforms.dpr, this.dpr);
      gl.uniform1f(this.uniforms.line, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.positions);
      gl.vertexAttribPointer(this.attributes.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.styleBuffer);
      if (this.stylesDirty) { gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.styles); this.stylesDirty = false; }
      gl.vertexAttribPointer(this.attributes.style, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, this.count);
      if (this.laserCount) {
        gl.uniform1f(this.uniforms.line, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.laserPositionBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.laserPositions.subarray(0, this.laserCount * 6));
        gl.vertexAttribPointer(this.attributes.position, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.laserStyleBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.laserStyles.subarray(0, this.laserCount * 6));
        gl.vertexAttribPointer(this.attributes.style, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, this.laserCount * 2);
      }
    } else {
      const context = this.context;
      context.setTransform(this.dpr, 0, 0, this.dpr, this.width * this.dpr / 2, this.height * this.dpr / 2);
      context.clearRect(-this.width / 2, -this.height / 2, this.width, this.height);
      // 备用渲染分四组批量提交，避免每颗粒子切换一次画笔造成低帧率。
      for (let group = 0; group < 4; group++) {
        context.fillStyle = group === 0 ? '#85c9bb' : '#dcf0e9';
        context.globalAlpha = 0.4 + group * 0.14;
        context.beginPath();
        for (let i = group; i < this.count; i += 4) {
          const index = i * 3;
          if (this.styles[index + 1] <= 0) continue;
          const perspective = 1 / (1 + this.positions[index + 2] * 0.28);
          const size = this.styles[index] * perspective * 0.75;
          context.rect(this.positions[index] * this.scale * perspective, this.positions[index + 1] * this.scale * perspective, size, size);
        }
        context.fill();
      }
      context.strokeStyle = '#a4e7db';
      context.lineWidth = 0.7;
      for (let group = 0; group < 4; group++) {
        context.globalAlpha = (group + 1) * 0.16;
        context.beginPath();
        for (let i = 0; i < this.laserCount; i++) {
          const offset = i * 6;
          if (Math.min(3, Math.floor(this.laserStyles[offset + 4] * 6)) !== group) continue;
          const from = 1 / (1 + this.laserPositions[offset + 2] * 0.28);
          const to = 1 / (1 + this.laserPositions[offset + 5] * 0.28);
          context.moveTo(this.laserPositions[offset] * this.scale * from, this.laserPositions[offset + 1] * this.scale * from);
          context.lineTo(this.laserPositions[offset + 3] * this.scale * to, this.laserPositions[offset + 4] * this.scale * to);
        }
        context.stroke();
      }
      context.globalAlpha = 1;
    }
  }

  tick(now) {
    if (this.paused) return;
    const elapsed = this.lastTime ? Math.min((now - this.lastTime) / 16.667, 2) : 1;
    this.lastTime = now;
    if (this.ready && !this.reducedMotion) {
      this.step(now, elapsed);
      this.draw();
      this.frameCount++;
    }
    // 减弱动态时停在静态点阵，仍保留阵营切换。
    if (!this.reducedMotion) this.frame = this.lifecycle.frame(this.tick);
  }

  pause() { this.paused = true; this.lifecycle.cancelFrame(this.frame); this.pointer.active = false; }
  dispose() {
    if (this.lifecycle.disposed) return;
    this.paused = true;
    this.ready = false;
    this.lifecycle.dispose();
    this.frame = 0;
    this.pointer.active = false;
  }

  resume() {
    if (this.lifecycle.disposed) return;
    this.lifecycle.cancelFrame(this.frame);
    this.paused = false;
    this.lastTime = 0;
    this.frame = this.lifecycle.frame(this.tick);
  }

  getState() {
    let error = 0, printedCount = 0;
    for (let i = 0; i < this.positions.length; i++) error += (this.positions[i] - this.targets[i]) ** 2;
    for (let i = 0; i < this.count; i++) if (this.styles[i * 3 + 1] > 0) printedCount++;
    return { renderer: this.renderer, count: this.count, motionProfile: this.motionProfile, forming: this.formationElapsed !== null, printedCount, laserCount: this.laserCount, reducedMotion: this.reducedMotion, targetError: Math.sqrt(error / this.count), frameCount: this.frameCount, pointerActive: this.pointer.active };
  }
}
