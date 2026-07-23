// bg.js — Three.js 数据粒子流背景
// 暴露 window.bgFX = { setTransferring(b), setProgress(p 0-100), setDirection(±1) }
// 发送：粒子左→右；接收：右→左；传输中进度越高流速越快（二次加速）、亮度提升。
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
  const PARTICLE_COUNT = isMobile ? 700 : 1600;
  const MAX_FLOW_BOOST = 4; // 传输完成时流速倍率：1 + 1² × 4 = 5x
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    1,
    300,
  );
  camera.position.z = 100;

  // z=0 平面的可视范围（粒子回卷边界）
  let bounds = computeBounds();
  function computeBounds() {
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    return { width: h * camera.aspect, height: h };
  }

  // 程序化生成光晕圆点贴图，无外部资源
  function makeGlowTexture() {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  const speeds = new Float32Array(PARTICLE_COUNT);
  const cyan = new THREE.Color("#22d3ee");
  const magenta = new THREE.Color("#e879f9");
  const tmpColor = new THREE.Color();

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * bounds.width;
    positions[i * 3 + 1] = (Math.random() - 0.5) * bounds.height;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 80;
    // 每粒子在青/品红之间随机取色，整体压暗，亮度交给 material.color 控制
    tmpColor.lerpColors(cyan, magenta, Math.random()).multiplyScalar(0.55);
    colors[i * 3] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
    speeds[i] = 8 + Math.random() * 16;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: isMobile ? 1.0 : 0.7,
    map: makeGlowTexture(),
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });

  scene.add(new THREE.Points(geometry, material));

  // 目标状态（由 bgFX 写入）与当前平滑值
  const target = { transferring: false, progress: 0, dir: 1 };
  const current = { flow: 1, dir: 1, brightness: 1 };
  const IDLE_TINT = new THREE.Color(0.75, 0.85, 1.0);
  const ACTIVE_TINT = new THREE.Color(1.5, 1.4, 1.6);
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
    const k = 1 - Math.pow(0.002, dt); // 帧率无关的平滑系数

    // 传输中流速 1 → 1 + p²×MAX_FLOW_BOOST（二次加速），空闲回落到 1
    const p = target.progress;
    const flowTarget = target.transferring ? 1 + p * p * MAX_FLOW_BOOST : 1;
    current.flow += (flowTarget - current.flow) * k;
    current.dir += (target.dir - current.dir) * k;
    const brightTarget = target.transferring ? 1 : 0;
    current.brightness += (brightTarget - current.brightness) * k;

    tint.lerpColors(IDLE_TINT, ACTIVE_TINT, current.brightness);
    material.color.copy(tint);

    const { width } = bounds;
    const half = width / 2;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      let x = positions[i * 3] + current.dir * speeds[i] * current.flow * dt;
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
      clock.getDelta(); // 丢弃暂停期间累积的时间
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
    renderer.render(scene, camera); // 只渲一帧静态画面
  } else {
    start();
  }
}
