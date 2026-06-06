import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { Environment, GradientTexture } from '@react-three/drei';
import * as THREE from 'three';
import { Bubble } from './Bubble';

// 薄膜与气泡阵列共享常量
const FILM_WIDTH = 8.4;
const FILM_HEIGHT = 8.4;
const FILM_SEG_X = 80;
const FILM_SEG_Z = 80;
const FILM_Y_OFFSET = -0.01; // 薄膜 mesh 相对世界原点的 Y 偏移
const BUBBLE_RADIUS = 0.4;
const BUBBLE_BASE_RADIUS = BUBBLE_RADIUS * 1.2; // 气泡底部半径
const BUBBLE_SPACING = 0.96;

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
      y +=
        Math.sin(x * 3.7 + z * 2.3) * 0.01 +
        Math.sin(rx * 6.1 + rz * 4.7 + 1.7) * 0.008 +
        Math.sin(rx2 * 11.3 - rz2 * 8.9 - 2.4) * 0.005 +
        Math.sin(rz * 15.7 + rx * 3.1 + 4.1) * 0.004 +
        Math.sin(x * z * 2.3 + rx2 * 7.7) * 0.005;

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
  }, [tiltX, tiltZ, floatAmp1, floatAmp2, floatAmp3]);

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
          colors={['#b8d8f8', '#ffeaa0', '#d4eab8']}
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

  useFrame((state) => {
    if (!lightRef.current || !filmMeshRef.current) return;
    raycaster.setFromCamera(state.pointer, state.camera);
    const intersects = raycaster.intersectObject(filmMeshRef.current);
    if (intersects.length > 0) {
      const p = intersects[0].point;
      lightRef.current.position.set(p.x, p.y + heightOffset, p.z);
    }
  });

  return <pointLight ref={lightRef} color={color} intensity={intensity} distance={distance} decay={decay} />;
}

function CameraController({ azimuth }: { azimuth: number }) {
  const { camera } = useThree();
  useFrame(() => {
    const dist = 10;
    const elevation = Math.PI / 4;
    const x = dist * Math.cos(elevation) * Math.sin(azimuth);
    const y = dist * Math.sin(elevation);
    const z = dist * Math.cos(elevation) * Math.cos(azimuth);
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
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

  // 薄膜几何数据（用于 getFilmSurface 插值）
  const filmDataRef = useRef<FilmGeometryData | null>(null);
  const filmMeshRef = useRef<THREE.Mesh>(null);
  const [filmRev, setFilmRev] = useState(0);

  const handleGeometryReady = useCallback<GeometryReadyFn>(
    (positions, width, height, segX, segZ) => {
      filmDataRef.current = { positions, width, height, segX, segZ };
      setFilmRev((r) => r + 1);
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
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        shadows
        orthographic
        camera={{
          position: [5, 7, 5],
          zoom: 55,
          near: 0.1,
          far: 100,
        }}
        style={{ background: '#f5f0eb' }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <ExposureController exposure={exposure} />
        <ambientLight intensity={ambientIntensity} color="#fff8f0" />
        <RotatingLights azimuth={azimuth} />

        <Environment files="/studio.hdr" environmentIntensity={envIntensity} environmentRotation={[hdrRotX, hdrRotY, 0]} />

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
          meshRef={filmMeshRef}
          onGeometryReady={handleGeometryReady}
        />

        {/* 8x8 气泡网格，依附于薄膜表面 */}
        {bubblePlacements.map((p, i) => {
          const isRed = i === 28;
          return (
            <Bubble
              key={i}
              position={p.position}
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
              color={isRed ? 'red' : 'default'}
              longPress={isRed}
              envMapIntensity={envIntensity}
              emissiveColor={emissiveColor}
              emissiveInt={emissiveIntensity}
              matTransmission={matTransmission}
              matRoughness={matRoughness}
              matIor={matIor}
              matThickness={matThickness}
              matOpacity={matOpacity}
              matAttenuationColor={matAttenuationColor}
            />
          );
        })}


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
      </Canvas>

      {/* 左侧材质面板 */}
      <div style={{
        position: 'absolute', bottom: 20, left: 20,
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
        position: 'absolute', bottom: 20, right: 20,
        background: 'rgba(255,255,255,0.9)', borderRadius: 8,
        padding: '12px 16px', fontSize: 12, fontFamily: 'monospace',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)', minWidth: 180,
        maxHeight: '80vh', overflowY: 'auto'
      }}>
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
    </div>
  );
}
