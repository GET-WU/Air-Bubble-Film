import { useState } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { Environment } from '@react-three/drei';
import { Bubble } from './Bubble';

function RotatingLights({ azimuth }: { azimuth: number }) {
  // 灯光跟随相机旋转，保持光影关系不变
  const offset = azimuth; // 相机方位角即灯光旋转角
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

function CameraController({ azimuth }: { azimuth: number }) {
  const { camera } = useThree();
  useFrame(() => {
    const dist = 10;
    const elevation = Math.PI / 4; // 45°仰角
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
  const [azimuth, setAzimuth] = useState(0.78); // ~45°
  const [wrinkleInf, setWrinkleInf] = useState(0.6);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        shadows
        orthographic
        camera={{
          position: [5, 7, 5],
          zoom: 80,
          near: 0.1,
          far: 100,
        }}
        style={{ background: '#f5f0eb' }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <ambientLight intensity={0.8} color="#fff8f0" />
        <RotatingLights azimuth={azimuth} />

        {/* 本地HDR环境贴图 */}
        <Environment files="/studio.hdr" environmentRotation={[0, azimuth, 0]} />

        {/* 4x4 气泡网格，其中index=7为红色长按气泡 */}
        {Array.from({ length: 16 }).map((_, i) => {
          const row = Math.floor(i / 4);
          const col = i % 4;
          const spacing = 2.8;
          const x = (col - 1.5) * spacing;
          const z = (row - 1.5) * spacing;
          const isRed = i === 7;
          return (
            <Bubble
              key={i}
              position={[x, 0, z]}
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
            />
          );
        })}

        <CameraController azimuth={azimuth} />
      </Canvas>

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
    </div>
  );
}
