import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { Environment, GradientTexture } from '@react-three/drei';
import { SvgTextMesh, FontData } from './SvgText';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';
import { Bubble } from './Bubble';
import { audioManager } from './AudioManager';

// 薄膜与气泡阵列共享常量
const FILM_WIDTH = 8.4;
const FILM_HEIGHT = 8.4;
const FILM_SEG_X = 80;
const FILM_SEG_Z = 80;
const FILM_Y_OFFSET = -0.01; // 薄膜 mesh 相对世界原点的 Y 偏移
const BUBBLE_RADIUS = 0.4;
const BUBBLE_BASE_RADIUS = BUBBLE_RADIUS * 1.2; // 气泡底部半径
const BUBBLE_SPACING = 0.96;

// 背景装饰模板配置（百分比值，以1:1画布为基准）—— 作为 state 初始值
const INITIAL_BG_LAYOUT = {
  whiteBlock: { left: 16.5, top: 0, width: 11, height: 10 },
  verticalBar: { left: 16.5, top: 46, width: 15, height: 28 },
  gradientBlock: { right: 16.5, bottom: 1.5, width: 11, height: 22 },
  title: { left: 15.5, top: 21, fontSize: 8 },
  version: { right: 16.5, top: 16, fontSize: 1.4 },
  credits: { left: 16.5, bottom: 11, fontSize: 1.4 },
};

const SMALL_BG_LAYOUT = {
  whiteBlock: { left: 6, top: -5, width: 19.5, height: 15 },
  verticalBar: { left: 6, top: 49, width: 19.5, height: 37 },
  gradientBlock: { right: 6, bottom: -5, width: 24, height: 32 },
  title: { left: 5.5, top: 20, fontSize: 18.5 },
  version: { right: 6, top: 12, fontSize: 3 },
  credits: { left: 6.5, bottom: 8, fontSize: 3 },
};
type BgLayout = typeof INITIAL_BG_LAYOUT;
type BgGroup = keyof BgLayout;

// 8x8 阵列的所有气泡 (x,z) 中心坐标
const BUBBLE_POSITIONS: Array<[number, number]> = (() => {
  const arr: Array<[number, number]> = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      arr.push([(col - 3.5) * BUBBLE_SPACING, (row - 3.5) * BUBBLE_SPACING]);
    }
  }
  return arr;
})();

interface FilmGeometryData {
  positions: Float32Array; // 顶点 position 数组（已 rotateX 后的世界坐标系）
  width: number;
  height: number;
  segX: number;
  segZ: number;
}

type GeometryReadyFn = (
  positions: Float32Array,
  width: number,
  height: number,
  segX: number,
  segZ: number,
) => void;

function FilmBase({
  tiltX,
  tiltZ,
  floatAmp1,
  floatAmp2,
  floatAmp3,
  envMapIntensity,
  emissiveColor,
  emissiveInt,
  matTransmission,
  matRoughness,
  matIor,
  matThickness,
  matOpacity,
  matAttenuationColor,
  wrinkleAmp,
  gradientColors,
  gradientRotation,
  meshRef,
  onGeometryReady,
}: {
  tiltX: number;
  tiltZ: number;
  floatAmp1: number;
  floatAmp2: number;
  floatAmp3: number;
  envMapIntensity: number;
  emissiveColor: string;
  emissiveInt: number;
  matTransmission: number;
  matRoughness: number;
  matIor: number;
  matThickness: number;
  matOpacity: number;
  matAttenuationColor: string;
  wrinkleAmp: number;
  gradientColors: [string, string, string];
  gradientRotation: number;
  meshRef: React.RefObject<THREE.Mesh>;
  onGeometryReady: GeometryReadyFn;
}) {
  const filmGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(FILM_WIDTH, FILM_HEIGHT, FILM_SEG_X, FILM_SEG_Z);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const sigma = 0.05;
    const ringAmp = 0.015;
    const dimpleAmp = 0.02;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);

      // 1) 倾斜（在噪声之前叠加）
      let y = x * Math.sin(tiltZ) + z * Math.sin(tiltX);

      // 1.5) 布料飘浮姿态：大幅度低频起伏模拟空中飘动
      y += Math.sin(x * 0.8 + 0.5) * Math.cos(z * 0.6 + 0.3) * floatAmp1
        + Math.sin(x * 0.4 - z * 0.7 + 1.2) * floatAmp2
        + Math.cos(x * 0.3 + z * 0.5 - 0.8) * floatAmp3;

      // 2) 多层非整数频率+旋转坐标叠加噪声褶皱
      const rx = x * 0.7 + z * 0.7;
      const rz = -x * 0.7 + z * 0.7;
      const rx2 = x * 0.9 - z * 0.4;
      const rz2 = x * 0.4 + z * 0.9;
      y += (
        Math.sin(x * 3.7 + z * 2.3) * 0.01 +
        Math.sin(rx * 6.1 + rz * 4.7 + 1.7) * 0.008 +
        Math.sin(rx2 * 11.3 - rz2 * 8.9 - 2.4) * 0.005 +
        Math.sin(rz * 15.7 + rx * 3.1 + 4.1) * 0.004 +
        Math.sin((x * z) * 2.3 + rx2 * 7.7) * 0.005
      ) * wrinkleAmp;

      // 3) 气泡底圆凹陷 + 张力凸起环
      for (let b = 0; b < BUBBLE_POSITIONS.length; b++) {
        const bx = BUBBLE_POSITIONS[b][0];
        const bz = BUBBLE_POSITIONS[b][1];
        const dx = x - bx;
        const dz = z - bz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < BUBBLE_BASE_RADIUS) {
          // 微凹（气泡重量压痕）
          y += -dimpleAmp * (1 - dist / BUBBLE_BASE_RADIUS);
        }
        // 高斯环（连接处张力）：仅在邻近 0.6 时产生显著贡献
        const d = dist - BUBBLE_BASE_RADIUS;
        if (d > -3 * sigma && d < 3 * sigma) {
          const g = Math.exp(-(d * d) / (2 * sigma * sigma));
          y += ringAmp * g;
        }
      }

      pos.setY(i, y);
    }

    // 4) 添加顶点色：气泡底部区域自发光暖色
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      let glow = 0;
      for (let b = 0; b < BUBBLE_POSITIONS.length; b++) {
        const bx = BUBBLE_POSITIONS[b][0];
        const bz = BUBBLE_POSITIONS[b][1];
        const dx = x - bx;
        const dz = z - bz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < BUBBLE_BASE_RADIUS * 1.2) {
          const t = 1 - dist / (BUBBLE_BASE_RADIUS * 1.2);
          glow = Math.max(glow, t * t);
        }
      }
      // 基色白 + 发光区域暖色
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 1;
      colors[i * 3 + 2] = 1;
      if (glow > 0) {
        colors[i * 3] = 1;
        colors[i * 3 + 1] = 1 - glow * 0.4; // 略减绿
        colors[i * 3 + 2] = 1 - glow * 0.7; // 减蓝，呈现暖橙
      }
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    return geo;
  }, [tiltX, tiltZ, floatAmp1, floatAmp2, floatAmp3, wrinkleAmp]);

  // 导出顶点数据给父组件用于查询表面
  useEffect(() => {
    const arr = filmGeo.attributes.position.array as Float32Array;
    onGeometryReady(
      new Float32Array(arr),
      FILM_WIDTH,
      FILM_HEIGHT,
      FILM_SEG_X,
      FILM_SEG_Z,
    );
  }, [filmGeo, onGeometryReady]);

  return (
    <mesh ref={meshRef} geometry={filmGeo} position={[0, FILM_Y_OFFSET, 0]} receiveShadow>
      <meshPhysicalMaterial
        vertexColors
        emissive={emissiveColor}
        emissiveIntensity={emissiveInt}
        transmission={matTransmission}
        thickness={matThickness}
        roughness={matRoughness}
        iridescence={0.2}
        iridescenceIOR={1.3}
        iridescenceThicknessRange={[200, 400]}
        clearcoat={0.15}
        clearcoatRoughness={0.4}
        ior={matIor}
        metalness={0}
        transparent
        opacity={matOpacity}
        side={THREE.DoubleSide}
        attenuationColor={matAttenuationColor}
        attenuationDistance={0.8}
        envMapIntensity={envMapIntensity}
      >
        <GradientTexture
          attach="map"
          stops={[0, 0.4, 1]}
          colors={gradientColors}
          rotation={gradientRotation}
        />
      </meshPhysicalMaterial>
    </mesh>
  );
}

function RotatingLights({ azimuth }: { azimuth: number }) {
  const offset = azimuth;
  const mainX = 5 * Math.sin(offset) + 5 * Math.cos(offset);
  const mainZ = 5 * Math.cos(offset) - 5 * Math.sin(offset);
  const fillX = -3 * Math.sin(offset) - 3 * Math.cos(offset);
  const fillZ = -3 * Math.cos(offset) + 3 * Math.sin(offset);
  return (
    <>
      <directionalLight
        position={[mainX, 10, mainZ]}
        intensity={0.9}
        color="#fff5e6"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-4}
        shadow-camera-right={4}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
        shadow-camera-near={0.1}
        shadow-camera-far={30}
      />
      <directionalLight position={[fillX, 5, fillZ]} intensity={0.3} color="#ffe8d6" />
    </>
  );
}

function ExposureController({ exposure }: { exposure: number }) {
  const { gl } = useThree();
  useFrame(() => {
    gl.toneMappingExposure = exposure;
  });
  return null;
}

function MouseLight({ filmMeshRef, intensity, color, heightOffset, distance, decay }: {
  filmMeshRef: React.RefObject<THREE.Mesh>;
  intensity: number;
  color: string;
  heightOffset: number;
  distance: number;
  decay: number;
}) {
  const lightRef = useRef<THREE.PointLight>(null);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const heightRef = useRef(heightOffset);
  heightRef.current = heightOffset;
  const onFilm = useRef(false);
  const fadeStart = useRef(0);
  const FADE_DURATION = 600;

  useFrame((state) => {
    if (!lightRef.current || !filmMeshRef.current) return;
    raycaster.setFromCamera(state.pointer, state.camera);
    const intersects = raycaster.intersectObject(filmMeshRef.current);
    const now = performance.now();
    if (intersects.length > 0) {
      const p = intersects[0].point;
      lightRef.current.position.set(p.x, p.y + heightRef.current, p.z);
      if (!onFilm.current) {
        onFilm.current = true;
        fadeStart.current = now;
      }
      // 渐显
      const elapsed = now - fadeStart.current;
      const t = Math.min(elapsed / FADE_DURATION, 1);
      lightRef.current.intensity = intensity * t;
    } else {
      if (onFilm.current) {
        onFilm.current = false;
        fadeStart.current = now;
      }
      // 渐隐
      const elapsed = now - fadeStart.current;
      const t = Math.min(elapsed / FADE_DURATION, 1);
      lightRef.current.intensity = intensity * (1 - t);
    }
  });

  return <pointLight ref={lightRef} color={color} intensity={0} distance={distance} decay={decay} />;
}

function IntroController({ loaded, groupRef, pressingRef }: { loaded: boolean; groupRef: React.RefObject<THREE.Group>; pressingRef: React.MutableRefObject<number> }) {
  const started = useRef(false);
  const startTime = useRef(0);
  const shakeStartTime = useRef(0); // 抖动开始时间
  const shakeStopTime = useRef(0);  // 抖动停止时间
  const lastProgress = useRef(0);   // 上一帧的progress
  const INTRO_OFFSET_Y = -1.0;
  const INTRO_DURATION = 1000;
  const SHAKE_DELAY = 400; // 延迟0.4秒

  useFrame(() => {
    if (!groupRef.current) return;
    if (!loaded) {
      groupRef.current.position.y = INTRO_OFFSET_Y;
      return;
    }
    if (!started.current) {
      started.current = true;
      startTime.current = performance.now();
    }
    const elapsed = performance.now() - startTime.current;
    const t = Math.min(elapsed / INTRO_DURATION, 1);
    const eased = 1 - Math.pow(1 - t, 5);
    let baseY = INTRO_OFFSET_Y * (1 - eased);

    const now = performance.now();
    const progress = pressingRef.current;

    // 记录抖动开始/停止时间
    if (progress > 0 && lastProgress.current === 0) {
      shakeStartTime.current = now; // 开始按压
    }
    if (progress === 0 && lastProgress.current > 0) {
      shakeStopTime.current = now; // 松手
    }
    lastProgress.current = progress;

    // 计算抖动强度：延迟开始，延迟结束
    let shakeIntensity = 0;
    if (progress > 0) {
      // 正在按压：延迟0.2s后才开始
      const pressingElapsed = now - shakeStartTime.current;
      if (pressingElapsed > SHAKE_DELAY) {
        shakeIntensity = progress;
      }
    } else if (shakeStopTime.current > 0) {
      // 已松手：继续抖0.2s后才停
      const fadeElapsed = now - shakeStopTime.current;
      if (fadeElapsed < SHAKE_DELAY) {
        shakeIntensity = lastProgress.current * (1 - fadeElapsed / SHAKE_DELAY);
      }
    }

    if (shakeIntensity > 0 && t >= 1) {
      const amp = shakeIntensity * 0.03;
      const freq = shakeIntensity * 0.07;
      baseY += Math.sin(now * freq) * amp;
      groupRef.current.position.x = Math.cos(now * freq * 1.4) * amp;
      groupRef.current.position.z = Math.sin(now * freq * 1.2 + 1.3) * amp * 0.7;
    } else {
      groupRef.current.position.x = 0;
      groupRef.current.position.z = 0;
    }
    groupRef.current.position.y = baseY;
  });
  return null;
}

// === Canvas 内的场景背景：纯色 + 装饰几何 ===
function SceneBG() {
  const { scene } = useThree();
  useEffect(() => {
    scene.background = new THREE.Color('#f5f0eb');
  }, [scene]);
  return null;
}

function SceneBackgroundWrapper({ layout, titleFont, sansFont, lightParams }: { layout: BgLayout; titleFont: FontData | null; sansFont: FontData | null; lightParams: { color: string; intensity: number; distance: number; decay: number; z: number } }) {
  const { viewport } = useThree();
  return <SceneBackground layout={layout} viewW={viewport.width} viewH={viewport.height} titleFont={titleFont} sansFont={sansFont} lightParams={lightParams} />;
}

function SceneBackground({ layout, viewW: _vw, viewH: _vh, titleFont, sansFont, lightParams }: { layout: BgLayout; viewW: number; viewH: number; titleFont: FontData | null; sansFont: FontData | null; lightParams: { color: string; intensity: number; distance: number; decay: number; z: number } }) {
  const groupRef = useRef<THREE.Group>(null);
  const bgLightRef = useRef<THREE.PointLight>(null);
  const whiteRef = useRef<THREE.Mesh>(null);
  const vertBarRef = useRef<THREE.Mesh>(null);
  const gradBlockRef = useRef<THREE.Mesh>(null);
  const titleRef = useRef<THREE.Group>(null);
  const versionRef = useRef<THREE.Group>(null);
  const creditsRef = useRef<THREE.Group>(null);
  const { camera, pointer, size } = useThree();
  const tmpDir = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (!groupRef.current) return;
    const ortho = camera as THREE.OrthographicCamera;
    const w = size.width / ortho.zoom;
    const h = size.height / ortho.zoom;
    const pctToX = (pct: number) => (pct / 100 - 0.5) * w;
    const pctToY = (pct: number) => -(pct / 100 - 0.5) * h;

    // 背景组放在相机前方远处
    tmpDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    groupRef.current.position.copy(camera.position).add(tmpDir.multiplyScalar(40));
    groupRef.current.lookAt(camera.position);
    groupRef.current.scale.set(1, 1, 1);

    // 背景光源跟随鼠标
    if (bgLightRef.current) {
      bgLightRef.current.position.set(pointer.x * w * 0.5, pointer.y * h * 0.5, lightParams.z);
    }

    // 更新 mesh 位置和尺寸
    const wb = layout.whiteBlock;
    const vb = layout.verticalBar;
    const gb = layout.gradientBlock;
    const gbLeft = 100 - gb.right - gb.width;
    const gbTop = 100 - gb.bottom - gb.height;

    if (whiteRef.current) {
      whiteRef.current.position.set(pctToX(wb.left + wb.width / 2), pctToY(wb.top + wb.height / 2), 0);
      whiteRef.current.scale.set((wb.width / 100) * w, (wb.height / 100) * h, 1);
    }
    if (vertBarRef.current) {
      vertBarRef.current.position.set(pctToX(vb.left + vb.width / 2), pctToY(vb.top + vb.height / 2), 0);
      vertBarRef.current.scale.set((vb.width / 100) * w, (vb.height / 100) * h, 1);
    }
    if (gradBlockRef.current) {
      gradBlockRef.current.position.set(pctToX(gbLeft + gb.width / 2), pctToY(gbTop + gb.height / 2), 0);
      gradBlockRef.current.scale.set((gb.width / 100) * w, (gb.height / 100) * h, 1);
    }
    if (titleRef.current) {
      titleRef.current.position.set(pctToX(layout.title.left), pctToY(layout.title.top), 0.02);
    }
    if (versionRef.current) {
      versionRef.current.position.set(pctToX(100 - layout.version.right), pctToY(layout.version.top), 0.02);
    }
    if (creditsRef.current) {
      creditsRef.current.position.set(pctToX(layout.credits.left), pctToY(100 - layout.credits.bottom), 0.02);
    }
  });

  const ortho = camera as THREE.OrthographicCamera;
  const w = size.width / ortho.zoom;
  const h = size.height / ortho.zoom;
  const vmin = Math.min(w, h);
  const titleFontSize = (layout.title.fontSize / 100) * vmin;
  const versionFontSize = (layout.version.fontSize / 100) * vmin;
  const creditsFontSize = (layout.credits.fontSize / 100) * vmin;

  return (
    <group ref={groupRef}>
      {/* 背景鼠标光源 */}
      <pointLight ref={bgLightRef} color={lightParams.color} intensity={lightParams.intensity} distance={lightParams.distance} decay={lightParams.decay} />
      {/* 左上角白色方块 */}
      <mesh ref={whiteRef}>
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial color="#ffffff" toneMapped={false} emissive="#ffffff" emissiveIntensity={0.2} />
      </mesh>
      {/* 左侧竖条白色渐变 */}
      <mesh ref={vertBarRef}>
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial color="#ffffff" transparent toneMapped={false} emissive="#ffffff" emissiveIntensity={0.2}>
          <GradientTexture attach="alphaMap" stops={[0, 1]} colors={['#ffffff', '#000000']} />
        </meshStandardMaterial>
      </mesh>
      {/* 右下角橙色渐变方块 */}
      <mesh ref={gradBlockRef}>
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial color="#F5BC67" transparent toneMapped={false} emissive="#F5BC67" emissiveIntensity={0.2}>
          <GradientTexture attach="alphaMap" stops={[0, 1]} colors={['#ffffff', '#000000']} />
        </meshStandardMaterial>
      </mesh>
      {/* 标题 "Air Bubble Film" */}
      {titleFont && (
        <group ref={titleRef}>
          <SvgTextMesh
            text={'Air\nBubble\nFilm'}
            fontData={titleFont}
            fontSize={titleFontSize}
            color="#574373"
            position={[0, 0, 0]}
            anchorX="left"
            anchorY="top"
            lineHeight={1.05}
          />
        </group>
      )}
      {/* 版本号 V 0.1.0 */}
      {sansFont && (
        <group ref={versionRef}>
          <SvgTextMesh
            text="V 0.1.0"
            fontData={sansFont}
            fontSize={versionFontSize}
            color="#574373"
            position={[0, 0, 0]}
            anchorX="right"
            anchorY="top"
          />
        </group>
      )}
      {/* 署名 */}
      {sansFont && (
        <group ref={creditsRef}>
          <SvgTextMesh
            text={'Designed by GET\nJune 07. 2026'}
            fontData={sansFont}
            fontSize={creditsFontSize}
            color="#574373"
            position={[0, 0, 0]}
            anchorX="left"
            anchorY="bottom"
            lineHeight={1.6}
          />
        </group>
      )}
    </group>
  );
}

function CameraController({ azimuth }: { azimuth: number }) {
  const { camera, size } = useThree();

  // 初始设置 zoom（确保第一帧 viewport 正确）
  useEffect(() => {
    const contentDiag = 11.9;
    const baseZoom = 55;
    const maxFill = 0.98;
    const fillAtBase = contentDiag * baseZoom / size.width;
    const ortho = camera as THREE.OrthographicCamera;
    ortho.zoom = fillAtBase <= maxFill ? baseZoom : size.width * maxFill / contentDiag;
    camera.updateProjectionMatrix();
  }, [camera, size.width]);

  useFrame(() => {
    const dist = 10;
    const elevation = Math.PI / 4;
    const x = dist * Math.cos(elevation) * Math.sin(azimuth);
    const y = dist * Math.sin(elevation);
    const z = dist * Math.cos(elevation) * Math.cos(azimuth);
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
    // 动态zoom：内容保持固定视觉大小，当超过画布98%时才缩小
    const contentDiag = 11.9;
    const baseZoom = 55; // 基准zoom（大屏下82%填充）
    const maxFill = 0.98;
    const fillAtBase = contentDiag * baseZoom / size.width;
    const ortho = camera as THREE.OrthographicCamera;
    if (fillAtBase <= maxFill) {
      ortho.zoom = baseZoom; // 未超限，保持固定大小
    } else {
      ortho.zoom = size.width * maxFill / contentDiag; // 超限，缩小到刚好98%
    }
    camera.updateProjectionMatrix();
  });
  return null;
}

export default function App() {
  const [strength, setStrength] = useState(0.08);
  const [radius, setRadius] = useState(4.0);
  const [cylHeight, setCylHeight] = useState(0.8);
  const [domeHt, setDomeHt] = useState(0.6);
  const [springK, setSpringK] = useState(200);
  const [damping, setDamping] = useState(10);
  const [kick, setKick] = useState(60);
  const [azimuth, setAzimuth] = useState(4.15);
  const [wrinkleInf, setWrinkleInf] = useState(0.6);

  // 薄膜倾斜调试参数
  const [filmTiltX, setFilmTiltX] = useState(0.265);
  const [filmTiltZ, setFilmTiltZ] = useState(0.1);
  // 薄膜飘浮幅度参数
  const [floatAmp1, setFloatAmp1] = useState(0.37);
  const [floatAmp2, setFloatAmp2] = useState(-0.71);
  const [floatAmp3, setFloatAmp3] = useState(0.32);
  // 环境贴图强度
  const [envIntensity, setEnvIntensity] = useState(0.3);
  const [hdrRotY, setHdrRotY] = useState(3.75);
  const [hdrRotX, setHdrRotX] = useState(0.21);

  // 光照参数
  const [exposure, setExposure] = useState(1.0);
  const [ambientIntensity, setAmbientIntensity] = useState(0);

  // 鼠标跟随光源
  const [mouseLightIntensity, setMouseLightIntensity] = useState(30);
  const [mouseLightColor, setMouseLightColor] = useState('#ff7300');
  const [mouseLightHeight, setMouseLightHeight] = useState(0.15);
  const [mouseLightDistance, setMouseLightDistance] = useState(3);
  const [mouseLightDecay, setMouseLightDecay] = useState(2);
  // 鼠标跟随光源2
  const [mouseLight2Intensity, setMouseLight2Intensity] = useState(10);
  const [mouseLight2Height, setMouseLight2Height] = useState(2);
  const [mouseLight2Distance, setMouseLight2Distance] = useState(10);
  const [mouseLight2Decay, setMouseLight2Decay] = useState(2);
  const [mouseLight2Color, setMouseLight2Color] = useState('#ff0000');

  // 自发光参数
  const [emissiveColor, setEmissiveColor] = useState('#9985ff');
  const [emissiveIntensity, setEmissiveIntensity] = useState(0.1);

  // 材质参数
  const [matTransmission, setMatTransmission] = useState(0.6);
  const [matRoughness, setMatRoughness] = useState(0.4);
  const [matIor, setMatIor] = useState(2.5);
  const [matThickness, setMatThickness] = useState(1.8);
  const [matOpacity, setMatOpacity] = useState(0.85);
  const [matAttenuationColor, setMatAttenuationColor] = useState('#ffd6d6');
  // 褒皱参数
  const [filmWrinkleAmp, setFilmWrinkleAmp] = useState(2.5);
  const [bubbleWrinkleAmp, setBubbleWrinkleAmp] = useState(1.0);
  // 调试
  const [debugFlat, setDebugFlat] = useState(false);
  // 普通气泡/薄膜渐变色
  const [gradient1, setGradient1] = useState('#ffffe1');
  const [gradient2, setGradient2] = useState('#ffffe1');
  const [gradient3, setGradient3] = useState('#b4dcf0');
  const [filmGradientRotation, setFilmGradientRotation] = useState(4.904);
  // 特殊气泡独立参数
  const [specialAttenuationColor, setSpecialAttenuationColor] = useState('#ffd6d6');
  const [specialEmissiveColor, setSpecialEmissiveColor] = useState('#ff0000');
  const [specialEmissiveInt, setSpecialEmissiveInt] = useState(0.2);
  const [specialGradient1, setSpecialGradient1] = useState('#fcffd6');
  const [specialGradient2, setSpecialGradient2] = useState('#fff04d');
  const [specialGradient3, setSpecialGradient3] = useState('#ff7b00');

  // 加载字形数据
  const [titleFont, setTitleFont] = useState<FontData | null>(null);
  const [sansFont, setSansFont] = useState<FontData | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}fonts/title-glyphs.json`).then(r => r.json()).then(setTitleFont);
    fetch(`${import.meta.env.BASE_URL}fonts/sans-glyphs.json`).then(r => r.json()).then(setSansFont);
  }, []);

  // 背景装饰布局（state 化，支持运行时调节）
  const [bgLayout, setBgLayout] = useState<BgLayout>(
    () => Math.min(window.innerWidth, window.innerHeight) >= 670 ? INITIAL_BG_LAYOUT : SMALL_BG_LAYOUT
  );
  const [bgPanelOpen, setBgPanelOpen] = useState(false);
  const [bgLightPanelOpen, setBgLightPanelOpen] = useState(false);
  const [bgLightParams, setBgLightParams] = useState({ color: '#ff7300', intensity: 60, distance: 12, decay: 1, z: 2 });

  // 窗口大小变化时切换布局
  useEffect(() => {
    const onResize = () => {
      const vmin = Math.min(window.innerWidth, window.innerHeight);
      setBgLayout(vmin >= 670 ? INITIAL_BG_LAYOUT : SMALL_BG_LAYOUT);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const updateBgField = useCallback(
    <G extends BgGroup, K extends keyof BgLayout[G]>(group: G, key: K, value: number) => {
      setBgLayout((prev) => ({
        ...prev,
        [group]: { ...prev[group], [key]: value },
      }));
    },
    [],
  );

  // 薄膜几何数据（用于 getFilmSurface 插值）
  const filmDataRef = useRef<FilmGeometryData | null>(null);
  const filmMeshRef = useRef<THREE.Mesh>(null);
  const [filmRev, setFilmRev] = useState(0);

  // 开场动画状态
  const [sceneLoaded, setSceneLoaded] = useState(false);
  const [introPlaying, setIntroPlaying] = useState(true);
  const introGroupRef = useRef<THREE.Group>(null);
  const [maskMounted, setMaskMounted] = useState(true);
  const globalPressingRef = useRef(0);

  // 加载完成后触发遮罩渐隐
  useEffect(() => {
    if (!sceneLoaded) return;
    setIntroPlaying(false);
    const timer = setTimeout(() => setMaskMounted(false), 550);
    return () => clearTimeout(timer);
  }, [sceneLoaded]);

  // 首次用户交互时恢复被浏览器阻止的音频（BGM 已在页面加载时尝试自动播放）
  useEffect(() => {
    const handleInteraction = () => {
      audioManager.resume();
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('touchstart', handleInteraction);
    };
    document.addEventListener('click', handleInteraction, { once: true });
    document.addEventListener('touchstart', handleInteraction, { once: true });
    return () => {
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('touchstart', handleInteraction);
    };
  }, []);

  // === 动态特殊气泡管理 ===
  // 戳破时一次判定：若该气泡将变为特殊，则加入 pending；恢复完成时 pending → special
  const deflatedRef = useRef<Set<number>>(new Set());
  const initialSpecial = useMemo(() => {
    const idx = Math.floor(Math.random() * BUBBLE_POSITIONS.length);
    return new Set([idx]);
  }, []);
  const specialRef = useRef<Set<number>>(initialSpecial);
  const [specialSet, setSpecialSet] = useState<Set<number>>(() => initialSpecial);
  const pendingSpecialRef = useRef<Set<number>>(new Set());
  const [pendingSpecialSet, setPendingSpecialSet] = useState<Set<number>>(new Set());
  // pendingRemove: 特殊气泡爆破后将变为普通
  const pendingRemoveSpecialRef = useRef<Set<number>>(new Set());
  const [pendingRemoveSet, setPendingRemoveSet] = useState<Set<number>>(new Set());

  const handleBubbleDeflate = useCallback((index: number) => {
    deflatedRef.current.add(index);

    if (specialRef.current.has(index)) {
      // 特殊气泡被戳破：同样做随机判定
      if (specialRef.current.size + pendingSpecialRef.current.size <= 5 && Math.random() < 0.4) {
        // 保持特殊，不做任何变化
      } else {
        // 将变为普通：标记 pendingRemove，瓦片保持 color='red' 直到 recover
        pendingRemoveSpecialRef.current.add(index);
        setPendingRemoveSet(new Set(pendingRemoveSpecialRef.current));
      }
      return;
    }

    // 普通气泡：判定是否将变为特殊
    if (specialRef.current.size + pendingSpecialRef.current.size < 5) {
      if (Math.random() < 0.4) {
        pendingSpecialRef.current.add(index);
        setPendingSpecialSet(new Set(pendingSpecialRef.current));
      }
    }
  }, []);

  const handleBubbleRecover = useCallback((index: number) => {
    deflatedRef.current.delete(index);
    // 特殊→普通：恢复后移除特殊状态
    if (pendingRemoveSpecialRef.current.has(index)) {
      pendingRemoveSpecialRef.current.delete(index);
      setPendingRemoveSet(new Set(pendingRemoveSpecialRef.current));
      specialRef.current.delete(index);
      setSpecialSet(new Set(specialRef.current));
      return;
    }
    // 普通→特殊：pending 提升为 special
    if (pendingSpecialRef.current.has(index)) {
      pendingSpecialRef.current.delete(index);
      setPendingSpecialSet(new Set(pendingSpecialRef.current));
      specialRef.current.add(index);
      setSpecialSet(new Set(specialRef.current));
    }
  }, []);

  const handleGeometryReady = useCallback<GeometryReadyFn>(
    (positions, width, height, segX, segZ) => {
      filmDataRef.current = { positions, width, height, segX, segZ };
      setFilmRev((r) => r + 1);
      setSceneLoaded(true);
    },
    [],
  );

  // 双线性插值查询薄膜表面 (x, z) 对应的世界 Y 与法线
  const getFilmSurface = useCallback(
    (x: number, z: number): { y: number; normal: THREE.Vector3 } => {
      const data = filmDataRef.current;
      if (!data) return { y: 0, normal: new THREE.Vector3(0, 1, 0) };
      const { positions, width, height, segX, segZ } = data;

      // PlaneGeometry(W,H) 经 rotateX(-PI/2) 后:
      //   worldX = localX, worldZ = -localY
      //   localX 沿 segX 方向从 -W/2 到 W/2 -> i = (worldX + W/2) * segX / W
      //   localY 沿 segZ 方向从 -H/2 到 H/2，但 worldZ = -localY
      //     -> j = (H/2 - worldZ) * segZ / H
      const fi = ((x + width / 2) * segX) / width;
      const fj = ((z + height / 2) * segZ) / height;
      const ci = Math.max(0, Math.min(segX, fi));
      const cj = Math.max(0, Math.min(segZ, fj));
      const i0 = Math.max(0, Math.min(segX - 1, Math.floor(ci)));
      const j0 = Math.max(0, Math.min(segZ - 1, Math.floor(cj)));
      const i1 = i0 + 1;
      const j1 = j0 + 1;
      const tu = ci - i0;
      const tv = cj - j0;

      const yAt = (i: number, j: number) => positions[(j * (segX + 1) + i) * 3 + 1];

      const y00 = yAt(i0, j0);
      const y10 = yAt(i1, j0);
      const y01 = yAt(i0, j1);
      const y11 = yAt(i1, j1);

      const y =
        (1 - tu) * (1 - tv) * y00 +
        tu * (1 - tv) * y10 +
        (1 - tu) * tv * y01 +
        tu * tv * y11 +
        FILM_Y_OFFSET;

      // 法线：在格子内对 Y 做有限差分
      const dxGrid = width / segX;
      const dzGrid = height / segZ;
      const dyDx = ((y10 - y00) + (y11 - y01)) * 0.5 / dxGrid;
      // j 直接用作 buffer iy 索引，iy 增大 -> worldZ 增大，故 (y[j+1]-y[j])/dzGrid = dY/dWorldZ
      const dyDz = (((y01 - y00) + (y11 - y10)) * 0.5) / dzGrid;
      // 法线 = (-dY/dX, 1, -dY/dZ)
      const normal = new THREE.Vector3(-dyDx, 1, -dyDz).normalize();
      return { y, normal };
    },
    [],
  );

  // 预计算每个气泡的 position / rotation（依赖 filmRev）
  const bubblePlacements = useMemo(() => {
    void filmRev; // 触发重算
    const up = new THREE.Vector3(0, 1, 0);
    return BUBBLE_POSITIONS.map(([bx, bz]) => {
      const { y, normal } = getFilmSurface(bx, bz);
      const quat = new THREE.Quaternion().setFromUnitVectors(up, normal);
      const euler = new THREE.Euler().setFromQuaternion(quat);
      return {
        position: [bx, y, bz] as [number, number, number],
        rotation: [euler.x, euler.y, euler.z] as [number, number, number],
      };
    });
  }, [filmRev, getFilmSurface]);

  return (
    <div className="app-container" style={{ position: 'relative', flexShrink: 0, overflow: 'hidden' }} onContextMenu={e => e.preventDefault()}>
      <Canvas
        shadows
        orthographic
        camera={{
          position: [5, 7, 5],
          zoom: 45,
          near: 0.1,
          far: 100,
        }}
        style={{ position: 'absolute', inset: 0, zIndex: 1 }}
        dpr={[1, Math.min(window.devicePixelRatio, 1.5)]}
        gl={{ antialias: true }}
      >
        <SceneBG />
        <ExposureController exposure={exposure} />
        <ambientLight intensity={ambientIntensity} color="#fff8f0" />
        <RotatingLights azimuth={azimuth} />

        <Environment files={`${import.meta.env.BASE_URL}studio.hdr`} environmentIntensity={envIntensity} environmentRotation={[hdrRotX, hdrRotY, 0]} />

        <IntroController loaded={sceneLoaded} groupRef={introGroupRef} pressingRef={globalPressingRef} />

        {/* 3D 背景装饰（面朝相机、位于气泡后方） */}
        <SceneBackgroundWrapper layout={bgLayout} titleFont={titleFont} sansFont={sansFont} lightParams={bgLightParams} />

        <group ref={introGroupRef}>
        {/* 地面塑料薄膜 */}
        <FilmBase
          tiltX={filmTiltX}
          tiltZ={filmTiltZ}
          floatAmp1={floatAmp1}
          floatAmp2={floatAmp2}
          floatAmp3={floatAmp3}
          envMapIntensity={envIntensity}
          emissiveColor={emissiveColor}
          emissiveInt={emissiveIntensity}
          matTransmission={matTransmission}
          matRoughness={matRoughness}
          matIor={matIor}
          matThickness={matThickness}
          matOpacity={matOpacity}
          matAttenuationColor={matAttenuationColor}
          wrinkleAmp={filmWrinkleAmp}
          gradientColors={[gradient1, gradient2, gradient3]}
          gradientRotation={filmGradientRotation}
          meshRef={filmMeshRef}
          onGeometryReady={handleGeometryReady}
        />

        {/* 8x8 气泡网格，依附于薄膜表面 */}
        {bubblePlacements.map((p, i) => {
          const isSpecial = specialSet.has(i);
          // 个别气泡Y轴偏移修正
          const yOffsets: Record<number, number> = {1:0.2,2:0.2,9:0.2,26:0.2,0:0.1,4:0.1,8:0.1,16:0.1,17:0.1,18:0.1,24:0.1,27:0.1,28:0.1,35:0.1,42:0.1,57:0.1};
          const yOff = yOffsets[i] || 0;
          const pos: [number, number, number] = [p.position[0], p.position[1] + yOff, p.position[2]];
          return (
            <group key={`group-${i}`}>
            <Bubble
              position={pos}
              rotation={p.rotation}
              radius={BUBBLE_RADIUS}
              seed={i}
              wrinkleInfluence={wrinkleInf}
              tractionStrength={strength}
              tractionRadius={radius}
              cylinderHeight={cylHeight}
              domeHeight={domeHt}
              reboundSpringK={springK}
              reboundDamping={damping}
              reboundKick={kick}
              color={isSpecial ? 'red' : 'default'}
              longPress={isSpecial}
              willBeSpecial={pendingSpecialSet.has(i)}
              willBeNormal={pendingRemoveSet.has(i)}
              onDeflate={() => handleBubbleDeflate(i)}
              onRecover={() => handleBubbleRecover(i)}
              globalPressingRef={globalPressingRef}
              specialAttenuationColor={specialAttenuationColor}
              specialEmissiveColor={specialEmissiveColor}
              specialEmissiveInt={specialEmissiveInt}
              specialGradient={[specialGradient1, specialGradient2, specialGradient3]}
              gradient={[gradient1, gradient2, gradient3]}
              envMapIntensity={envIntensity}
              emissiveColor={emissiveColor}
              emissiveInt={emissiveIntensity}
              matTransmission={matTransmission}
              matRoughness={matRoughness}
              matIor={matIor}
              matThickness={matThickness}
              matOpacity={matOpacity}
              matAttenuationColor={matAttenuationColor}
              bubbleWrinkleAmp={bubbleWrinkleAmp}
              debugFlat={debugFlat}
            />
            </group>
          );
        })}
        </group>


        {/* 鼠标跟随光源（贴在薄膜表面） */}
        <MouseLight
          filmMeshRef={filmMeshRef}
          intensity={mouseLightIntensity}
          color={mouseLightColor}
          heightOffset={mouseLightHeight}
          distance={mouseLightDistance}
          decay={mouseLightDecay}
        />
        <MouseLight
          filmMeshRef={filmMeshRef}
          intensity={mouseLight2Intensity}
          color={mouseLight2Color}
          heightOffset={mouseLight2Height}
          distance={mouseLight2Distance}
          decay={mouseLight2Decay}
        />

        <CameraController azimuth={azimuth} />

        {/* Bloom 后处理 - 暂时禁用调试 */}
        {false && <EffectComposer>
          <Bloom
            mipmapBlur
            intensity={0.4}
            luminanceThreshold={0.6}
            luminanceSmoothing={0.9}
            radius={0.8}
          />
        </EffectComposer>}
      </Canvas>

      {/* 左侧材质面板 */}
      <div style={{
        position: 'absolute', bottom: 20, left: 20, zIndex: 10, display: 'none',
        background: 'rgba(255,255,255,0.9)', borderRadius: 8,
        padding: '12px 16px', fontSize: 12, fontFamily: 'monospace',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)', minWidth: 180,
        maxHeight: '80vh', overflowY: 'auto'
      }}>
        <div style={{ fontWeight: 600, marginBottom: 8, color: '#666' }}>材质参数</div>
        <div style={{ marginBottom: 4 }}>
          <label>透射率: {matTransmission.toFixed(2)}</label><br/>
          <input type="range" min="0" max="1" step="0.05"
            value={matTransmission}
            onChange={e => setMatTransmission(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>粗糙度: {matRoughness.toFixed(2)}</label><br/>
          <input type="range" min="0" max="1" step="0.05"
            value={matRoughness}
            onChange={e => setMatRoughness(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>折射率: {matIor.toFixed(2)}</label><br/>
          <input type="range" min="1" max="2.5" step="0.05"
            value={matIor}
            onChange={e => setMatIor(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>厚度: {matThickness.toFixed(2)}</label><br/>
          <input type="range" min="0" max="5" step="0.1"
            value={matThickness}
            onChange={e => setMatThickness(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>不透明度: {matOpacity.toFixed(2)}</label><br/>
          <input type="range" min="0" max="1" step="0.05"
            value={matOpacity}
            onChange={e => setMatOpacity(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>衰减色: </label>
          <input type="color" value={matAttenuationColor}
            onChange={e => setMatAttenuationColor(e.target.value)}
            style={{ verticalAlign: 'middle' }} />
        </div>
        <div style={{ marginTop: 8, borderTop: '1px solid #eee', paddingTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: '#666' }}>特殊气泡</div>
          <div style={{ marginBottom: 4 }}>
            <label>衰减色: </label>
            <input type="color" value={specialAttenuationColor}
              onChange={e => setSpecialAttenuationColor(e.target.value)}
              style={{ verticalAlign: 'middle' }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label>自发光颜色: </label>
            <input type="color" value={specialEmissiveColor}
              onChange={e => setSpecialEmissiveColor(e.target.value)}
              style={{ verticalAlign: 'middle' }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label>自发光强度: {specialEmissiveInt.toFixed(2)}</label><br/>
            <input type="range" min="0" max="2" step="0.1"
              value={specialEmissiveInt}
              onChange={e => setSpecialEmissiveInt(+e.target.value)}
              style={{ width: 160 }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label>渐变色1: </label>
            <input type="color" value={specialGradient1}
              onChange={e => setSpecialGradient1(e.target.value)}
              style={{ verticalAlign: 'middle' }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label>渐变色2: </label>
            <input type="color" value={specialGradient2}
              onChange={e => setSpecialGradient2(e.target.value)}
              style={{ verticalAlign: 'middle' }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label>渐变色3: </label>
            <input type="color" value={specialGradient3}
              onChange={e => setSpecialGradient3(e.target.value)}
              style={{ verticalAlign: 'middle' }} />
          </div>
        </div>
        <div style={{ marginTop: 8, borderTop: '1px solid #eee', paddingTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: '#666' }}>自发光</div>
          <div style={{ marginBottom: 4 }}>
            <label>颜色: </label>
            <input type="color" value={emissiveColor}
              onChange={e => setEmissiveColor(e.target.value)}
              style={{ verticalAlign: 'middle' }} />
          </div>
          <div>
            <label>强度: {emissiveIntensity.toFixed(2)}</label><br/>
            <input type="range" min="0" max="2" step="0.05"
              value={emissiveIntensity}
              onChange={e => setEmissiveIntensity(+e.target.value)}
              style={{ width: 160 }} />
          </div>
        </div>
        <div style={{ marginTop: 8, borderTop: '1px solid #eee', paddingTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: '#666' }}>渐变色</div>
          <div style={{ marginBottom: 4 }}>
            <label>色1: </label>
            <input type="color" value={gradient1}
              onChange={e => setGradient1(e.target.value)}
              style={{ verticalAlign: 'middle' }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label>色2: </label>
            <input type="color" value={gradient2}
              onChange={e => setGradient2(e.target.value)}
              style={{ verticalAlign: 'middle' }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label>色3: </label>
            <input type="color" value={gradient3}
              onChange={e => setGradient3(e.target.value)}
              style={{ verticalAlign: 'middle' }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label>薄膜渐变方向: {(filmGradientRotation * 180 / Math.PI).toFixed(0)}°</label><br/>
            <input type="range" min="0" max="6.283" step="0.1"
              value={filmGradientRotation}
              onChange={e => setFilmGradientRotation(+e.target.value)}
              style={{ width: 160 }} />
          </div>
        </div>
        <div style={{ marginTop: 8, borderTop: '1px solid #eee', paddingTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: '#666' }}>褒皱</div>
          <div style={{ marginBottom: 4 }}>
            <label>气泡褶皱: {bubbleWrinkleAmp.toFixed(2)}</label><br/>
            <input type="range" min="0" max="3" step="0.05"
              value={bubbleWrinkleAmp}
              onChange={e => setBubbleWrinkleAmp(+e.target.value)}
              style={{ width: 160 }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label>褶皱衰减: {wrinkleInf.toFixed(2)}</label><br/>
            <input type="range" min="0" max="2" step="0.05"
              value={wrinkleInf}
              onChange={e => setWrinkleInf(+e.target.value)}
              style={{ width: 160 }} />
          </div>
          <div>
            <label>薄膜褶皱: {filmWrinkleAmp.toFixed(2)}</label><br/>
            <input type="range" min="0" max="3" step="0.05"
              value={filmWrinkleAmp}
              onChange={e => setFilmWrinkleAmp(+e.target.value)}
              style={{ width: 160 }} />
          </div>
        </div>
      </div>

      {/* 牵引力调节控件（隐藏） */}
      {false && <div style={{
        position: 'absolute', bottom: 20, left: 20,
        background: 'rgba(255,255,255,0.9)', borderRadius: 8,
        padding: '12px 16px', fontSize: 13, fontFamily: 'monospace',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
      }}>
        <div style={{ marginBottom: 8 }}>
          <label>强度: {strength.toFixed(2)}</label><br/>
          <input type="range" min="0" max="0.5" step="0.01" value={strength}
            onChange={e => setStrength(+e.target.value)} style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>半径(×r): {radius.toFixed(1)}</label><br/>
          <input type="range" min="0.5" max="6" step="0.1" value={radius}
            onChange={e => setRadius(+e.target.value)} style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>圆柱高(×r): {cylHeight.toFixed(2)}</label><br/>
          <input type="range" min="0.1" max="1.2" step="0.05" value={cylHeight}
            onChange={e => setCylHeight(+e.target.value)} style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>球帽高(×r): {domeHt.toFixed(2)}</label><br/>
          <input type="range" min="0.05" max="0.8" step="0.05" value={domeHt}
            onChange={e => setDomeHt(+e.target.value)} style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>弹簧刚度: {springK}</label><br/>
          <input type="range" min="20" max="300" step="10" value={springK}
            onChange={e => setSpringK(+e.target.value)} style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>阻尼: {damping}</label><br/>
          <input type="range" min="0.5" max="10" step="0.5" value={damping}
            onChange={e => setDamping(+e.target.value)} style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>反向速度: {kick}</label><br/>
          <input type="range" min="5" max="80" step="5" value={kick}
            onChange={e => setKick(+e.target.value)} style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>方位角: {(azimuth * 180 / Math.PI).toFixed(0)}°</label><br/>
          <input type="range" min="0" max="6.28" step="0.05" value={azimuth}
            onChange={e => setAzimuth(+e.target.value)} style={{ width: 160 }} />
        </div>
        <div>
          <label>褶纹影响: {wrinkleInf.toFixed(2)}</label><br/>
          <input type="range" min="0" max="2" step="0.05" value={wrinkleInf}
            onChange={e => setWrinkleInf(+e.target.value)} style={{ width: 160 }} />
        </div>
      </div>}

      {/* 调试面板（右下角） */}
      <div style={{
        position: 'absolute', bottom: 20, right: 20, zIndex: 10, display: 'none',
        background: 'rgba(255,255,255,0.9)', borderRadius: 8,
        padding: '12px 16px', fontSize: 12, fontFamily: 'monospace',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)', minWidth: 180,
        maxHeight: '80vh', overflowY: 'auto'
      }}>
        {/* 调试开关 */}
        <div style={{ marginBottom: 8 }}>
          <label>
            <input type="checkbox" checked={debugFlat} onChange={e => setDebugFlat(e.target.checked)} />
            {' '}全部扁平（调试）
          </label>
        </div>
        {/* 薄膜姿态部分——隐藏 */}
        {false && <>
        <div style={{ fontWeight: 600, marginBottom: 8, color: '#666' }}>薄膜姿态</div>
        <div style={{ marginBottom: 8 }}>
          <label>相机方位: {(azimuth * 180 / Math.PI).toFixed(0)}°</label><br/>
          <input type="range" min="0" max="6.28" step="0.05"
            value={azimuth}
            onChange={e => setAzimuth(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>倾斜 X: {filmTiltX.toFixed(3)} rad</label><br/>
          <input type="range" min="-1" max="1" step="0.005"
            value={filmTiltX}
            onChange={e => setFilmTiltX(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div>
          <label>倾斜 Z: {filmTiltZ.toFixed(3)} rad</label><br/>
          <input type="range" min="-1" max="1" step="0.005"
            value={filmTiltZ}
            onChange={e => setFilmTiltZ(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginTop: 8 }}>
          <label>飘浮1: {floatAmp1.toFixed(2)}</label><br/>
          <input type="range" min="-1" max="1" step="0.01"
            value={floatAmp1}
            onChange={e => setFloatAmp1(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginTop: 4 }}>
          <label>飘浮2: {floatAmp2.toFixed(2)}</label><br/>
          <input type="range" min="-1" max="1" step="0.01"
            value={floatAmp2}
            onChange={e => setFloatAmp2(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginTop: 4 }}>
          <label>飘浮3: {floatAmp3.toFixed(2)}</label><br/>
          <input type="range" min="-1" max="1" step="0.01"
            value={floatAmp3}
            onChange={e => setFloatAmp3(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        </>}
        <div style={{ marginTop: 8, borderTop: '1px solid #eee', paddingTop: 8 }}>
          <label>HDR方向: {(hdrRotY * 180 / Math.PI).toFixed(0)}°</label><br/>
          <input type="range" min="0" max="6.28" step="0.05"
            value={hdrRotY}
            onChange={e => setHdrRotY(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginTop: 4 }}>
          <label>HDR仰角: {(hdrRotX * 180 / Math.PI).toFixed(0)}°</label><br/>
          <input type="range" min="-3.14" max="3.14" step="0.05"
            value={hdrRotX}
            onChange={e => setHdrRotX(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginTop: 4 }}>
          <label>HDR强度: {envIntensity.toFixed(2)}</label><br/>
          <input type="range" min="0" max="5" step="0.1"
            value={envIntensity}
            onChange={e => setEnvIntensity(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginTop: 4 }}>
          <label>曝光: {exposure.toFixed(2)}</label><br/>
          <input type="range" min="0.1" max="3" step="0.05"
            value={exposure}
            onChange={e => setExposure(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginTop: 4 }}>
          <label>环境光: {ambientIntensity.toFixed(2)}</label><br/>
          <input type="range" min="0" max="3" step="0.05"
            value={ambientIntensity}
            onChange={e => setAmbientIntensity(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ fontWeight: 600, marginTop: 10, marginBottom: 6, color: '#666' }}>鼠标光源</div>
        <div style={{ marginBottom: 4 }}>
          <label>强度: {mouseLightIntensity.toFixed(0)}</label><br/>
          <input type="range" min="0" max="30" step="1"
            value={mouseLightIntensity}
            onChange={e => setMouseLightIntensity(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>高度: {mouseLightHeight.toFixed(2)}</label><br/>
          <input type="range" min="0" max="3" step="0.01"
            value={mouseLightHeight}
            onChange={e => setMouseLightHeight(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>距离: {mouseLightDistance.toFixed(1)}</label><br/>
          <input type="range" min="1" max="30" step="0.5"
            value={mouseLightDistance}
            onChange={e => setMouseLightDistance(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>衰减: {mouseLightDecay.toFixed(1)}</label><br/>
          <input type="range" min="0" max="5" step="0.1"
            value={mouseLightDecay}
            onChange={e => setMouseLightDecay(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div>
          <label>颜色: </label>
          <input type="color" value={mouseLightColor}
            onChange={e => setMouseLightColor(e.target.value)}
            style={{ verticalAlign: 'middle' }} />
        </div>
        <div style={{ fontWeight: 600, marginTop: 10, marginBottom: 6, color: '#666' }}>鼠标光源2</div>
        <div style={{ marginBottom: 4 }}>
          <label>强度: {mouseLight2Intensity.toFixed(0)}</label><br/>
          <input type="range" min="0" max="50" step="1"
            value={mouseLight2Intensity}
            onChange={e => setMouseLight2Intensity(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>高度: {mouseLight2Height.toFixed(2)}</label><br/>
          <input type="range" min="0" max="10" step="0.1"
            value={mouseLight2Height}
            onChange={e => setMouseLight2Height(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <label>距离: {mouseLight2Distance.toFixed(1)}</label><br/>
          <input type="range" min="1" max="50" step="1"
            value={mouseLight2Distance}
            onChange={e => setMouseLight2Distance(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div>
          <label>衰减: {mouseLight2Decay.toFixed(1)}</label><br/>
          <input type="range" min="0" max="5" step="0.1"
            value={mouseLight2Decay}
            onChange={e => setMouseLight2Decay(+e.target.value)}
            style={{ width: 160 }} />
        </div>
        <div>
          <label>颜色: </label>
          <input type="color" value={mouseLight2Color}
            onChange={e => setMouseLight2Color(e.target.value)}
            style={{ verticalAlign: 'middle' }} />
        </div>
      </div>

      {/* 开场渐显遮罩 */}
      {maskMounted && (
        <div style={{
          position: 'absolute',
          inset: 0,
          background: '#f5f0eb',
          zIndex: 5,
          opacity: introPlaying ? 1 : 0,
          transition: 'opacity 500ms cubic-bezier(0.0, 0.0, 0.1, 1)',
          pointerEvents: 'none',
        }} />
      )}

      {/* 背景布局调节面板（隐藏） */}
      {false && <BgLayoutPanel
        open={bgPanelOpen}
        onToggle={() => setBgPanelOpen((v) => !v)}
        layout={bgLayout}
        onChange={updateBgField}
      />}

      {/* 背景光源控制面板（隐藏） */}
      {false && <BgLightPanel
        open={bgLightPanelOpen}
        onToggle={() => setBgLightPanelOpen((v) => !v)}
        params={bgLightParams}
        onChange={(key, val) => setBgLightParams(p => ({ ...p, [key]: val }))}
      />}
    </div>
  );
}

// === 背景光源控制面板 ===
function BgLightPanel({ open, onToggle, params, onChange }: {
  open: boolean;
  onToggle: () => void;
  params: { color: string; intensity: number; distance: number; decay: number; z: number };
  onChange: (key: string, val: number | string) => void;
}) {
  return (
    <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 9999, background: 'rgba(255,255,255,0.95)', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontFamily: 'monospace', minWidth: 200, boxShadow: '0 2px 12px rgba(0,0,0,0.1)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', fontWeight: 700, color: '#574373' }} onClick={onToggle}>
        <span>背景光源</span><span>{open ? '▴' : '▾'}</span>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <label style={{ display: 'block', marginBottom: 6 }}>
            color <input type="color" value={params.color} onChange={e => onChange('color', e.target.value)} style={{ marginLeft: 8, verticalAlign: 'middle' }} />
          </label>
          <label style={{ display: 'block', marginBottom: 6 }}>
            intensity <input type="number" value={params.intensity} step={5} onChange={e => onChange('intensity', +e.target.value)} style={{ width: 60, marginLeft: 8 }} />
          </label>
          <label style={{ display: 'block', marginBottom: 6 }}>
            distance <input type="number" value={params.distance} step={1} onChange={e => onChange('distance', +e.target.value)} style={{ width: 60, marginLeft: 8 }} />
          </label>
          <label style={{ display: 'block', marginBottom: 6 }}>
            decay <input type="number" value={params.decay} step={0.5} onChange={e => onChange('decay', +e.target.value)} style={{ width: 60, marginLeft: 8 }} />
          </label>
          <label style={{ display: 'block', marginBottom: 6 }}>
            z <input type="number" value={params.z} step={0.5} onChange={e => onChange('z', +e.target.value)} style={{ width: 60, marginLeft: 8 }} />
          </label>
        </div>
      )}
    </div>
  );
}

// === 背景布局调节面板 ===
const BG_FIELD_GROUPS: ReadonlyArray<{
  group: BgGroup;
  label: string;
  fields: ReadonlyArray<string>;
}> = [
  { group: 'whiteBlock',    label: '白色方块', fields: ['left', 'top', 'width', 'height'] },
  { group: 'verticalBar',   label: '竖条渐变', fields: ['left', 'top', 'width', 'height'] },
  { group: 'gradientBlock', label: '渐变色块', fields: ['right', 'bottom', 'width', 'height'] },
  { group: 'title',         label: '标题',         fields: ['left', 'top', 'fontSize'] },
  { group: 'version',       label: '版本号',       fields: ['right', 'top', 'fontSize'] },
  { group: 'credits',       label: '署名',         fields: ['left', 'bottom', 'fontSize'] },
];

function BgLayoutPanel({
  open,
  onToggle,
  layout,
  onChange,
}: {
  open: boolean;
  onToggle: () => void;
  layout: BgLayout;
  onChange: <G extends BgGroup, K extends keyof BgLayout[G]>(group: G, key: K, value: number) => void;
}) {
  return (
    <div style={{
      position: 'fixed',
      top: 10,
      right: 10,
      zIndex: 9999,
      background: 'rgba(255,255,255,0.92)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      borderRadius: 10,
      boxShadow: '0 4px 18px rgba(0,0,0,0.12)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 11,
      color: '#333',
      width: open ? 240 : 'auto',
      maxHeight: open ? '90vh' : 'auto',
      overflowY: open ? 'auto' : 'hidden',
      transition: 'width 160ms ease',
    }}>
      {/* 可点击标题栏 */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          all: 'unset',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          boxSizing: 'border-box',
          padding: '10px 14px',
          cursor: 'pointer',
          fontWeight: 600,
          letterSpacing: '0.04em',
          color: '#574373',
          borderBottom: open ? '1px solid #eee' : 'none',
          userSelect: 'none',
        }}
      >
        <span>背景布局</span>
        <span style={{
          display: 'inline-block',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 160ms ease',
          fontSize: 10,
          color: '#999',
        }}>▾</span>
      </button>

      {open && (
        <div style={{ padding: '10px 14px 14px' }}>
          {BG_FIELD_GROUPS.map(({ group, label, fields }) => (
            <div key={group} style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.08em',
                color: '#888',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}>{label}</div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '6px 8px',
              }}>
                {fields.map((f) => {
                  const value = (layout[group] as Record<string, number>)[f];
                  return (
                    <label key={f} style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}>
                      <span style={{ color: '#999', fontSize: 10 }}>{f}</span>
                      <input
                        type="number"
                        step={0.5}
                        value={value}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!Number.isNaN(v)) {
                            onChange(group, f as keyof BgLayout[typeof group], v);
                          }
                        }}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '4px 6px',
                          border: '1px solid #ddd',
                          borderRadius: 4,
                          fontFamily: 'inherit',
                          fontSize: 11,
                          background: '#fafafa',
                          outline: 'none',
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
