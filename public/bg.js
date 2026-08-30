// bg.js — Three.js 数据粒子流背景（深色仪器面板 / 蓝图蓝）
// 暴露 window.bgFX = { setTransferring(b), setProgress(p 0-100), setDirection(±1) }
// 发送：粒子左→右；接收：右→左；传输中进度越高流速越快（二次加速）、不透明度提升。
// 背景加载失败时不挂 bgFX，调用方一律可选链，功能不受影响。

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";

const canvas = document.getElementById("bg-canvas");

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference: "low-power",
  });
} catch {
  // 无 WebGL 环境：静默退出，页面照常可用
}

if (renderer) {
  const isMobile =
    window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;
  const PARTICLE_COUNT = isMobile ? 400 : 900;
  const MAX_FLOW_BOOST = 4;
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    1,
    300,
  );
  camera.position.z = 100;

  let bounds = computeBounds();
  function computeBounds() {
    const h =
      2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    return { width: h * camera.aspect, height: h };
  }

  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  const speeds = new Float32Array(PARTICLE_COUNT);
  const signalBlue = new THREE.Color("#8fa8c4");
  const signalPale = new THREE.Color("#4a6080");
  const tmpColor = new THREE.Color();

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const z = (Math.random() - 0.5) * 80;
    positions[i * 3] = (Math.random() - 0.5) * bounds.width;
    positions[i * 3 + 1] = (Math.random() - 0.5) * bounds.height;
    positions[i * 3 + 2] = z;
    // 按 z 深度烘焙蓝图蓝深浅：近处更实、远处更淡
    const depthT = (z + 40) / 80;
    tmpColor.lerpColors(signalPale, signalBlue, depthT);
    colors[i * 3] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
    speeds[i] = 6 + Math.random() * 12;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: isMobile ? 1.2 : 0.9,
    vertexColors: true,
    transparent: true,
    opacity: 0.14,
    blending: THREE.NormalBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });

  scene.add(new THREE.Points(geometry, material));

  const target = { transferring: false, progress: 0, dir: 1 };
  const current = { flow: 1, dir: 1, intensity: 0 };
  // 深底上「活跃」= 更亮更实
  const IDLE_TINT = new THREE.Color(0.45, 0.52, 0.65);
  const ACTIVE_TINT = new THREE.Color(0.72, 0.8, 0.92);
  const tint = new THREE.Color();

  window.bgFX = {
    setTransferring(b) {
      target.transferring = Boolean(b);
    },
    setProgress(p) {
      target.progress = THREE.MathUtils.clamp((p || 0) / 100, 0, 1);
    },
    setDirection(d) {
      target.dir = d >= 0 ? 1 : -1;
    },
  };

  const clock = new THREE.Clock();
  let rafId = null;

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const k = 1 - Math.pow(0.002, dt);

    const p = target.progress;
    const flowTarget = target.transferring ? 1 + p * p * MAX_FLOW_BOOST : 1;
    current.flow += (flowTarget - current.flow) * k;
    current.dir += (target.dir - current.dir) * k;
    const intensityTarget = target.transferring ? 1 : 0;
    current.intensity += (intensityTarget - current.intensity) * k;

    tint.lerpColors(IDLE_TINT, ACTIVE_TINT, current.intensity);
    material.color.copy(tint);
    material.opacity = 0.12 + current.intensity * 0.18;

    const { width } = bounds;
    const half = width / 2;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      let x =
        positions[i * 3] + current.dir * speeds[i] * current.flow * dt;
      if (x > half) x -= width;
      else if (x < -half) x += width;
      positions[i * 3] = x;
    }
    geometry.attributes.position.needsUpdate = true;

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (rafId === null) {
      clock.getDelta();
      rafId = requestAnimationFrame(tick);
    }
  }
  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    bounds = computeBounds();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  if (reducedMotion) {
    renderer.render(scene, camera);
  } else {
    start();
  }
}
