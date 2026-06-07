import { useRef, useState, useMemo, useEffect } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { GradientTexture } from '@react-three/drei';
import * as THREE from 'three';
import { audioManager } from './AudioManager';

type Phase = 'idle' | 'deflating' | 'deflated' | 'recovering';

// 戳破动画时长（毫秒）
const DEFLATE_MS = 100;
const DEFLATED_HOLD_MS = 3000;
const RECOVER_MS = 600;

interface BubbleProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  radius?: number;
  tractionStrength?: number; // 相对于radius的强度系数
  tractionRadius?: number;  // 相对于radius的影响范围倍数
  cylinderHeight?: number;  // 圆柱高度倍数(×r)
  domeHeight?: number;      // 球帽高度倍数(×r)
  reboundSpringK?: number;  // 回弹弹簧刚度
  reboundDamping?: number;  // 回弹阻尼
  reboundKick?: number;     // 回弹初始反向速度倍数
  seed?: number;            // 随机种子，让每个气泡褶纹不同
  wrinkleInfluence?: number; // 褶纹影响度（0~1，控制proximity对褶纹的衰减强度）
  color?: 'default' | 'red'; // 气泡颜色
  willBeSpecial?: boolean;   // 处于 deflated 时将过渡为特殊气泡
  willBeNormal?: boolean;    // 处于 deflated 时将过渡为普通气泡
  specialAttenuationColor?: string; // 特殊气泡衰减色
  specialEmissiveColor?: string;    // 特殊气泡自发光颜色
  specialEmissiveInt?: number;      // 特殊气泡自发光强度
  specialGradient?: [string, string, string]; // 特殊气泡渐变色
  gradient?: [string, string, string]; // 普通气泡渐变色
  longPress?: boolean;       // 是否启用长按戳破模式
  longPressDuration?: number; // 长按所需时长(ms)
  onDeflate?: () => void;     // 气泡开始瘡时回调
  onRecover?: () => void;     // 气泡恢复完成时回调
  globalPressingRef?: React.MutableRefObject<number>; // 全局长按进度共享(0=未按, 0~1=按压进度)
  envMapIntensity?: number;   // 环境贴图强度
  emissiveColor?: string;     // 自发光颜色
  emissiveInt?: number;       // 自发光强度
  matTransmission?: number;
  matRoughness?: number;
  matIor?: number;
  matThickness?: number;
  matOpacity?: number;
  matAttenuationColor?: string;
  bubbleWrinkleAmp?: number; // 气泡褒皱强度倍率
  debugFlat?: boolean; // 调试：强制扁平
}

export function Bubble({ position = [0, 0, 0], rotation = [0, 0, 0], radius = 1, tractionStrength = 0.35, tractionRadius = 3.0, cylinderHeight: cylH = 0.8, domeHeight: domeH = 0.6, reboundSpringK = 120, reboundDamping = 4, reboundKick = 40, seed = 0, wrinkleInfluence = 1.0, color = 'default', willBeSpecial = false, willBeNormal = false, longPress = false, longPressDuration = 1000, onDeflate, onRecover, globalPressingRef, specialAttenuationColor = '#ff4444', specialEmissiveColor = '#ff4444', specialEmissiveInt = 0.5, specialGradient = ['#f8b8b8', '#ff6666', '#d84848'], gradient = ['#b8d8f8', '#ffeaa0', '#d4eab8'], envMapIntensity = 0.6, emissiveColor = '#ff9300', emissiveInt = 0.3, matTransmission = 0.65, matRoughness = 0.4, matIor = 1.5, matThickness = 1.8, matOpacity = 0.95, matAttenuationColor = '#ffcc77', bubbleWrinkleAmp = 1.0, debugFlat = false }: BubbleProps) {
  const groupRef = useRef<THREE.Group>(null);
  const domeRef = useRef<THREE.Mesh>(null);
  const capRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const phaseRef = useRef<Phase>('idle');
  const elapsedRef = useRef(0);
  const colorTransitionRef = useRef(0); // 0=普通 1=特殊
  const [lerpGradient, setLerpGradient] = useState<[string, string, string] | null>(null);
  const [hovered, setHovered] = useState(false);
  // 颜色插值复用对象，避免每帧分配
  const tmpColorA = useRef(new THREE.Color());
  const tmpColorB = useRef(new THREE.Color());

  // --- Mouse traction deformation ---
  const smoothMousePos = useRef(new THREE.Vector3(0, -999, 0));
  const originalPositions = useRef<Float32Array | null>(null); // 带褶纱的顶点
  const smoothPositions = useRef<Float32Array | null>(null);   // 无褶纱的平滑顶点
  // hover拉高状态
  const hoverScaleY = useRef(1);
  // 圆柱部分顶点数量（用于区分圆柱和球帽）
  const cylinderVertexCount = useRef(0);
  const currentOffsetX = useRef(0);
  const currentOffsetZ = useRef(0);
  const velocityX = useRef(0);
  const velocityZ = useRef(0);
  const isRebounding = useRef(false);
  // 长按戳破状态
  const isPressing = useRef(false);
  const ownsGlobalShake = useRef(false); // 本气泡是否在控制全局抖动
  const pressStartTime = useRef(0);
  const squeezeCtrlRef = useRef<{ stop: () => void } | null>(null);
  // 投影平面设在气泡顶部高度，45°等距视角下视觉位置与XZ坐标正确对应
  const intersectPlane = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, 1, 0), -(position[1] + radius)),
    [position, radius],
  );
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const pointerNdc = useRef(new THREE.Vector2(0, 0));

  // 气泡形状：底部垂直壁+顶部圆润的“圆柱加球帽”形
  const domeGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const segments = 64;
    const ringsCylinder = 8;  // 圆柱部分的环数
    const cylinderHeight = radius * cylH; // 圆柱部分高度
    const domeHeight = radius * domeH;      // 球帽部分高度
    const baseRadius = radius * 1.2;      // 底部半径

    const vertices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // === 圆柱部分（底部垂直壁） ===
    for (let ring = 0; ring <= ringsCylinder; ring++) {
      const t = ring / ringsCylinder; // 0(底)到1(顶)
      const y = t * cylinderHeight;
      for (let seg = 0; seg <= segments; seg++) {
        const theta = (seg / segments) * Math.PI * 2;
        const x = Math.cos(theta) * baseRadius;
        const z = Math.sin(theta) * baseRadius;
        vertices.push(x, y, z);
        normals.push(Math.cos(theta), 0, Math.sin(theta));
        uvs.push(seg / segments, t * 0.4);
      }
    }

    // === 球帽部分（经纬线布线） ===
    const ringsDome = 20;
    for (let ring = 1; ring <= ringsDome; ring++) {
      const t = ring / ringsDome;
      const phi = t * Math.PI * 0.5;
      const r = baseRadius * Math.cos(phi);
      const y = cylinderHeight + domeHeight * Math.sin(phi);
      for (let seg = 0; seg <= segments; seg++) {
        const theta = (seg / segments) * Math.PI * 2;
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;
        vertices.push(x, y, z);
        const nx = Math.cos(theta) * Math.cos(phi);
        const ny = Math.sin(phi);
        const nz = Math.sin(theta) * Math.cos(phi);
        normals.push(nx, ny, nz);
        uvs.push(seg / segments, 0.4 + t * 0.6);
      }
    }

    // === 构建三角形索引 ===
    const totalRings = ringsCylinder + ringsDome;
    for (let ring = 0; ring < totalRings; ring++) {
      for (let seg = 0; seg < segments; seg++) {
        const a = ring * (segments + 1) + seg;
        const b = a + segments + 1;
        indices.push(a, b, a + 1);
        indices.push(b, b + 1, a + 1);
      }
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    // === 塑料薄膜表面微扰动：沿法线方向施加程序化噪声位移 ===
    // seed 让每个气泡褶纹不同
    {
      const pos = geo.attributes.position;
      const cylCount = (ringsCylinder + 1) * (segments + 1);
      // 用seed生成多个独立的随机相位，打破方向性
      const s1 = seed * 7.31 + 1.23;
      const s2 = seed * 3.17 + 5.67;
      const s3 = seed * 11.03 + 2.89;
      const s4 = seed * 5.41 + 8.13;
      const s5 = seed * 9.73 + 4.51;
      // 随机旋转角度，让每个气泡的褶皱方向不同
      const rotAngle = seed * 2.39;
      const cosR = Math.cos(rotAngle);
      const sinR = Math.sin(rotAngle);
    
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
    
        const isCylinder = i < cylCount;
    
        // 圆柱底部不扰动（y接近0时衰减）
        const cylHeightVal = radius * cylH;
        const heightRatio = isCylinder ? Math.min(y / (cylHeightVal * 0.3), 1) : 1;
        if (heightRatio < 0.01) continue;
    
        const amp = (isCylinder ? radius * 0.015 : radius * 0.008) * bubbleWrinkleAmp;
    
        // 旋转坐标打破统一方向性
        const rx = x * cosR - z * sinR;
        const rz = x * sinR + z * cosR;
    
        // 多频sin组合 + 独立相位
        const wrinkle =
          Math.sin(rx * 11 + rz * 9 + s1) * 0.4 +
          Math.sin(rz * 14 - y * 7 + s2) * 0.3 +
          Math.sin(rx * 19 + y * 11 + rz * 6 + s3) * 0.3;
    
        // 高频划痕，方向也随机化
        const scratch =
          Math.sin(rx * 42 + rz * 28 + s4) * 0.15 +
          Math.sin(rz * 55 - rx * 18 + s5) * 0.12;
    
        const noise = (wrinkle + scratch) * amp * heightRatio;
    
        // 圆柱部分沿XZ径向扰动，球帽沿全径向
        if (isCylinder) {
          const rLen = Math.sqrt(x * x + z * z);
          if (rLen > 0.01) {
            pos.setXYZ(i, x + (x / rLen) * noise, y, z + (z / rLen) * noise);
          }
        } else {
          const len = Math.sqrt(x * x + y * y + z * z);
          if (len > 0.01) {
            const inv = noise / len;
            pos.setXYZ(i, x + x * inv, y + y * inv, z + z * inv);
          }
        }
      }
    }

    geo.computeVertexNormals();
    // 记录圆柱部分顶点数
    cylinderVertexCount.current = (ringsCylinder + 1) * (segments + 1);
    return geo;
  }, [radius, cylH, domeH, seed, bubbleWrinkleAmp]);

  // Store original vertex positions once geometry is created
  useEffect(() => {
    const posAttr = domeGeometry.attributes.position;
    // 带褶纱的顶点（当前几何体）
    originalPositions.current = new Float32Array(posAttr.array.length);
    originalPositions.current.set(posAttr.array);
    // 无褶纱的平滑顶点（在扰动之前的状态）
    // 重新生成一份无扰动的几何体来获取平滑位置
    const segments = 64;
    const ringsCylinder = 8;
    const ringsDome = 20;
    const cylinderHeight = radius * cylH;
    const domeHeight = radius * domeH;
    const baseRadius = radius * 1.2;
    const smoothVerts: number[] = [];
    for (let ring = 0; ring <= ringsCylinder; ring++) {
      const t = ring / ringsCylinder;
      const y = t * cylinderHeight;
      for (let seg = 0; seg <= segments; seg++) {
        const theta = (seg / segments) * Math.PI * 2;
        smoothVerts.push(Math.cos(theta) * baseRadius, y, Math.sin(theta) * baseRadius);
      }
    }
    for (let ring = 1; ring <= ringsDome; ring++) {
      const t = ring / ringsDome;
      const phi = t * Math.PI * 0.5;
      const r = baseRadius * Math.cos(phi);
      const y = cylinderHeight + domeHeight * Math.sin(phi);
      for (let seg = 0; seg <= segments; seg++) {
        const theta = (seg / segments) * Math.PI * 2;
        smoothVerts.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
      }
    }
    smoothPositions.current = new Float32Array(smoothVerts);
  }, [domeGeometry, radius, cylH, domeH]);

  // bottom cap — closes the hemisphere so the bubble has body/thickness
  const capGeometry = useMemo(() => {
    const g = new THREE.CircleGeometry(radius * 1.2, 64); // 匹配底部半径
    g.rotateX(Math.PI / 2);
    return g;
  }, [radius]);

  const handlePop = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    // 长按模式下不通过点击直接戳破
    if (longPress) return;
    if (phaseRef.current !== 'idle') return;
    phaseRef.current = 'deflating';
    elapsedRef.current = 0;
    audioManager.play();
    onDeflate?.();
  };

  // 滑动戳破：鼠标按下状态下划入气泡触发戳破或长按
  const handlePointerEnter = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!(e.nativeEvent.buttons & 1)) return; // 主键未按下则忽略
    if (phaseRef.current !== 'idle') return;
    if (longPress) {
      // 红色气泡：滑入时开始长按计时
      isPressing.current = true;
      pressStartTime.current = performance.now();
      squeezeCtrlRef.current = audioManager.playSqueeze();
    } else {
      // 普通气泡：直接戳破
      phaseRef.current = 'deflating';
      elapsedRef.current = 0;
      hoverScaleY.current = 1.2 / cylH; // 设置hover拉高状态，恢复后产生弹性回落
      audioManager.play();
      onDeflate?.();
    }
  };

  // 长按按下事件：进入按压状态，开始计时
  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!longPress) return;
    e.stopPropagation();
    if (phaseRef.current !== 'idle') return;
    isPressing.current = true;
    pressStartTime.current = performance.now();
    squeezeCtrlRef.current = audioManager.playSqueeze();
  };

  // 长按模式下监听全局 pointerup，松开即终止按压
  useEffect(() => {
    if (!longPress) return;
    const onUp = () => {
      isPressing.current = false;
      // 未触发爆破时停止挤压音效
      if (squeezeCtrlRef.current) {
        squeezeCtrlRef.current.stop();
        squeezeCtrlRef.current = null;
      }
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, [longPress]);

  useFrame((state, dt) => {
    const g = groupRef.current;
    const dome = domeRef.current;
    const cap = capRef.current;
    if (!g || !dome || !cap) return;

    // 调试模式：强制扁平
    if (debugFlat) {
      if (phaseRef.current === 'idle') {
        phaseRef.current = 'deflated';
      }
      if (phaseRef.current === 'deflated') {
        elapsedRef.current = 0; // 持续重置，永远不进入 recovering
      }
    } else if (!debugFlat && phaseRef.current === 'deflated' && elapsedRef.current >= DEFLATED_HOLD_MS) {
      phaseRef.current = 'recovering';
      elapsedRef.current = 0;
    }

    const phase = phaseRef.current;

    // === 颜色预告渐变：将变为特殊气泡的预告色过渡 ===
    // 计算颜色过渡进度并直接设置材质属性（绕过JSX props覆盖问题）
    if (matRef.current) {
      if (willBeSpecial && color !== 'red') {
        // 普通→特殊 过渡
        let ct = colorTransitionRef.current;
        if (phase === 'deflated') {
          ct = Math.min(elapsedRef.current / DEFLATED_HOLD_MS, 1);
        } else if (phase === 'recovering' || phase === 'idle') {
          ct = 1;
        }
        colorTransitionRef.current = ct;
        tmpColorA.current.set(matAttenuationColor).lerp(tmpColorB.current.set(specialAttenuationColor), ct);
        matRef.current.attenuationColor.copy(tmpColorA.current);
        tmpColorA.current.set(emissiveColor).lerp(tmpColorB.current.set(specialEmissiveColor), ct);
        matRef.current.emissive.copy(tmpColorA.current);
        matRef.current.emissiveIntensity = emissiveInt + (specialEmissiveInt - emissiveInt) * ct;
        const c1 = new THREE.Color(gradient[0]).lerp(new THREE.Color(specialGradient[0]), ct);
        const c2 = new THREE.Color(gradient[1]).lerp(new THREE.Color(specialGradient[1]), ct);
        const c3 = new THREE.Color(gradient[2]).lerp(new THREE.Color(specialGradient[2]), ct);
        setLerpGradient(['#' + c1.getHexString(), '#' + c2.getHexString(), '#' + c3.getHexString()]);
      } else if (willBeNormal && color === 'red') {
        // 特殊→普通 过渡（反向）
        let ct = colorTransitionRef.current;
        if (phase === 'deflated') {
          ct = Math.min(elapsedRef.current / DEFLATED_HOLD_MS, 1);
        } else if (phase === 'recovering' || phase === 'idle') {
          ct = 1;
        }
        colorTransitionRef.current = ct;
        tmpColorA.current.set(specialAttenuationColor).lerp(tmpColorB.current.set(matAttenuationColor), ct);
        matRef.current.attenuationColor.copy(tmpColorA.current);
        tmpColorA.current.set(specialEmissiveColor).lerp(tmpColorB.current.set(emissiveColor), ct);
        matRef.current.emissive.copy(tmpColorA.current);
        matRef.current.emissiveIntensity = specialEmissiveInt + (emissiveInt - specialEmissiveInt) * ct;
        const c1 = new THREE.Color(specialGradient[0]).lerp(new THREE.Color(gradient[0]), ct);
        const c2 = new THREE.Color(specialGradient[1]).lerp(new THREE.Color(gradient[1]), ct);
        const c3 = new THREE.Color(specialGradient[2]).lerp(new THREE.Color(gradient[2]), ct);
        setLerpGradient(['#' + c1.getHexString(), '#' + c2.getHexString(), '#' + c3.getHexString()]);
      } else if (color === 'red') {
        matRef.current.attenuationColor.set(specialAttenuationColor);
        matRef.current.emissive.set(specialEmissiveColor);
        matRef.current.emissiveIntensity = specialEmissiveInt;
        colorTransitionRef.current = 0;
        if (!lerpGradient || lerpGradient[0] !== specialGradient[0]) setLerpGradient([...specialGradient] as [string, string, string]);
      } else {
        if (lerpGradient !== null) setLerpGradient(null);
        colorTransitionRef.current = 0;
      }
    }

    // === 长按戳破：挤压变形 + 抖动反馈 ===
    if (longPress) {
      if (isPressing.current && phase === 'idle') {
        const now = performance.now();
        const pressProgress = Math.min(1, (now - pressStartTime.current) / longPressDuration);
        // 同步长按进度到全局ref
        if (globalPressingRef) {
          globalPressingRef.current = pressProgress;
          ownsGlobalShake.current = true;
        }
        // 逐顶点挤压：底部不动，中部最胖，顶部收回——形成馒头/水滴形
        if (originalPositions.current) {
          const posAttr = domeGeometry.attributes.position;
          const orig = originalPositions.current;
          const totalH = radius * (cylH + domeH);
          for (let i = 0; i < posAttr.count; i++) {
            const oy = orig[i * 3 + 1];
            const hRatio = Math.min(1, oy / totalH); // 0=底, 1=顶
            // 水滴形曲线：中部最胖，底部稍微变大，顶部收回
            const bulge = Math.sin(hRatio * Math.PI) * 0.6 + 0.4; // 0.4→1→0.4
            const fatten = 1 + pressProgress * 0.15 * bulge; // XZ变胖
            const squash = 1 - pressProgress * 0.3 * hRatio; // Y压扁仍按高度线性
            posAttr.setXYZ(
              i,
              orig[i * 3] * fatten,
              orig[i * 3 + 1] * squash,
              orig[i * 3 + 2] * fatten,
            );
          }
          posAttr.needsUpdate = true;
          domeGeometry.computeVertexNormals();
        }
        // 高频抖动，随进度增强
        const shakeAmp = radius * 0.03 * pressProgress;
        g.position.x = Math.sin(now * 0.05) * shakeAmp;
        g.position.z = Math.cos(now * 0.1) * shakeAmp;
    
        if (pressProgress >= 1) {
          // 达阈：触发 deflating
          phaseRef.current = 'deflating';
          elapsedRef.current = 0;
          isPressing.current = false;
          // 不立即重置 globalPressingRef，让 IntroController 的淡出机制处理延缓结束
          squeezeCtrlRef.current = null;
          g.position.x = 0;
          g.position.z = 0;
          onDeflate?.();
        }
        return;
      } else if (!isPressing.current && phase === 'idle' && originalPositions.current) {
        // 松手时仅当本气泡拥有全局抖动控制权时才重置
        if (ownsGlobalShake.current && globalPressingRef) {
          globalPressingRef.current = 0;
          ownsGlobalShake.current = false;
        }
        // 松手后弹性恢复原始形态
        const posAttr = domeGeometry.attributes.position;
        const orig = originalPositions.current;
        let needsRestore = false;
        for (let i = 0; i < posAttr.count; i++) {
          const cx = posAttr.getX(i), cy = posAttr.getY(i), cz = posAttr.getZ(i);
          const ox = orig[i * 3], oy = orig[i * 3 + 1], oz = orig[i * 3 + 2];
          if (Math.abs(cx - ox) > 0.001 || Math.abs(cy - oy) > 0.001 || Math.abs(cz - oz) > 0.001) {
            needsRestore = true;
            const lerpF = Math.min(1, dt * 10);
            posAttr.setXYZ(i, cx + (ox - cx) * lerpF, cy + (oy - cy) * lerpF, cz + (oz - cz) * lerpF);
          }
        }
        if (needsRestore) {
          posAttr.needsUpdate = true;
          domeGeometry.computeVertexNormals();
        }
        // 抖动位置恢复
        g.position.x += (0 - g.position.x) * Math.min(1, dt * 10);
        g.position.z += (0 - g.position.z) * Math.min(1, dt * 10);
      }
      // 爆破后（phase不再是 idle）且本气泡拥有抖动控制权，释放控制权
      if (phase !== 'idle' && ownsGlobalShake.current) {
        if (globalPressingRef) globalPressingRef.current = 0;
        ownsGlobalShake.current = false;
      }
    }

    // --- Mouse traction: compute mouse world position ---
    pointerNdc.current.set(state.pointer.x, state.pointer.y);
    raycaster.setFromCamera(pointerNdc.current, state.camera);
    const hitPoint = new THREE.Vector3();
    const didHit = raycaster.ray.intersectPlane(intersectPlane, hitPoint);

    if (didHit) {
      smoothMousePos.current.lerp(hitPoint, Math.min(1, dt * 12));
    }

    // --- Apply vertex displacement when idle (surface offset model) ---
    if (phase === 'idle' && originalPositions.current && smoothPositions.current) {
      const posAttr = domeGeometry.attributes.position;
      const orig = originalPositions.current;
      const smooth = smoothPositions.current;
      const count = posAttr.count;

      // 所有参数基于 radius 计算，保证不同气泡尺寸下效果一致
      const influenceRadius = tractionRadius * radius;
      const strength = tractionStrength;

      // Bubble world offset
      const bx = position[0];
      const bz = position[2];

      const mx = smoothMousePos.current.x;
      const mz = smoothMousePos.current.z;

      // 计算鼠标相对于气泡中心的偏移（不归一化，方向和幅度连续变化无突变）
      const offsetX = mx - bx;
      const offsetZ = mz - bz;
      const offsetDist = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);

      // 目标偏移量 + 接近度（用于褶纹衰减）
      let targetX = 0, targetZ = 0;
      let proximity = 0; // 0=远离，1=最近
      if (offsetDist <= influenceRadius) {
        const t = offsetDist / influenceRadius;
        const falloff = Math.pow(1 - t * t, 2);
        targetX = offsetX * falloff * strength;
        targetZ = offsetZ * falloff * strength;
        proximity = falloff; // 接近度=衰减值
      }

      // 牵引力活跃时：直接应用，不走弹簧
      const hasTarget = (Math.abs(targetX) > 0.0001 || Math.abs(targetZ) > 0.0001);

      let curX: number, curZ: number;

      if (hasTarget) {
        // 鼠标在范围内：即时响应
        curX = targetX;
        curZ = targetZ;
        // 记录当前偏移，供离开时回弹用
        currentOffsetX.current = curX;
        currentOffsetZ.current = curZ;
        velocityX.current = 0;
        velocityZ.current = 0;
        isRebounding.current = false;
      } else {
        // 鼠标离开：触发回弹振荡
        if (!isRebounding.current && (Math.abs(currentOffsetX.current) > 0.0001 || Math.abs(currentOffsetZ.current) > 0.0001)) {
          isRebounding.current = true;
          // 给一个反向初速度，强化回弹感知
          velocityX.current = -currentOffsetX.current * reboundKick;
          velocityZ.current = -currentOffsetZ.current * reboundKick;
        }

        if (isRebounding.current) {
          const springK = reboundSpringK;
          const damping = reboundDamping;
          const forceX = -currentOffsetX.current * springK - velocityX.current * damping;
          const forceZ = -currentOffsetZ.current * springK - velocityZ.current * damping;
          velocityX.current += forceX * dt;
          velocityZ.current += forceZ * dt;
          currentOffsetX.current += velocityX.current * dt;
          currentOffsetZ.current += velocityZ.current * dt;

          // 回弹结束判定
          if (Math.abs(currentOffsetX.current) < 0.0001 && Math.abs(currentOffsetZ.current) < 0.0001 &&
              Math.abs(velocityX.current) < 0.001 && Math.abs(velocityZ.current) < 0.001) {
            currentOffsetX.current = 0;
            currentOffsetZ.current = 0;
            velocityX.current = 0;
            velocityZ.current = 0;
            isRebounding.current = false;
          }
        }

        curX = currentOffsetX.current;
        curZ = currentOffsetZ.current;
      }

      const curMag = Math.sqrt(curX * curX + curZ * curZ);

      if (curMag < 0.0001 && proximity < 0.01) {
        posAttr.array.set(orig);
      } else {
        // 变形越大褶纱越少：用接近度驱动（鼠标越近气泡中心，变形越大，褶纹越少）
        const wrinkleFade = 1 - proximity * wrinkleInfluence; // wrinkleInfluence控制衰减强度

        for (let i = 0; i < count; i++) {
          // 在带褶纹和平滑顶点之间插值
          const baseX = smooth[i * 3] + (orig[i * 3] - smooth[i * 3]) * wrinkleFade;
          const baseY = smooth[i * 3 + 1] + (orig[i * 3 + 1] - smooth[i * 3 + 1]) * wrinkleFade;
          const baseZ = smooth[i * 3 + 2] + (orig[i * 3 + 2] - smooth[i * 3 + 2]) * wrinkleFade;

          const heightFactor = Math.max(0, Math.min(1, baseY / (radius * 0.85)));
          const maxDisp = radius * 0.3;
          const dx = curX * heightFactor;
          const dz = curZ * heightFactor;
          const len = Math.sqrt(dx * dx + dz * dz);
          const clampedScale = len > maxDisp ? maxDisp / len : 1;

          posAttr.setXYZ(
            i,
            baseX + dx * clampedScale,
            baseY,
            baseZ + dz * clampedScale,
          );
        }
      }

      posAttr.needsUpdate = true;
      domeGeometry.computeVertexNormals();
    } else if (phase !== 'idle' && originalPositions.current && smoothPositions.current) {
      // === 戳破效果：deflating / deflated / recovering ===
      elapsedRef.current += dt * 1000;
      const t = elapsedRef.current;

      // 计算塌陷进度 p：0=完整气泡，1=完全瘡平
      let p = 0;
      if (phase === 'deflating') {
        // easeOut：前半段快、后半段慢
        const tn = Math.min(t / DEFLATE_MS, 1);
        p = 1 - Math.pow(1 - tn, 3);
      } else if (phase === 'deflated') {
        p = 1;
      } else {
        // recovering：前半段慢后半段快（easeIn），曲线更陡峣
        const tn = Math.min(t / RECOVER_MS, 1);
        p = 1 - tn * tn * tn * tn * tn * tn;
      }

      const posAttr = domeGeometry.attributes.position;
      const orig = originalPositions.current;
      const smooth = smoothPositions.current;
      const count = posAttr.count;
      const totalHeight = radius * (cylH + domeH);

      // recovering时水平抖动：随时间衰减的高频抖动
      let shakeX = 0, shakeZ = 0;
      if (phase === 'recovering') {
        const tn2 = Math.min(t / RECOVER_MS, 1);
        const shakeAmp = radius * 0.05 * (1 - tn2);
        shakeX = Math.sin(t * 0.05 + seed * 2.1) * shakeAmp;
        shakeZ = Math.cos(t * 0.07 + seed * 4.3) * shakeAmp;
      }

      // deflating时变胖：初期迅速膨胀然后消退
      let deflateBulge = 0;
      if (phase === 'deflating') {
        // p: 0→1，bulge在p=0.3时最大然后衰减
        deflateBulge = Math.sin(p * Math.PI) * 0.3;
      }

      // 瘪下去时褶纱增强基准值（实际用localWrinkle按区域计算）
      void p; // wrinkle scaling handled per-vertex below
      
      for (let i = 0; i < count; i++) {
        const sx = smooth[i * 3];
        const sy = smooth[i * 3 + 1];
        const sz = smooth[i * 3 + 2];
        // 球帽顶部区域完全用平滑坐标（避免中心星形图案）
        const rDist = Math.sqrt(sx * sx + sz * sz);
        const baseRad = radius * 1.2;
        const edgeRatio = rDist / baseRad; // 0=中心，1=边缘
        // 根据p混合：p=1时完全用smooth，p=0时回到orig（避免恢复时跳变）
        let ox: number, oy: number, oz: number;
        if (edgeRatio > 0.85) {
          // 圆柱外缘：放大褶纱
          const wrinkleAmt = 1 + p * 2.5 * ((edgeRatio - 0.85) / 0.15);
          ox = sx + (orig[i * 3] - sx) * wrinkleAmt;
          oy = sy + (orig[i * 3 + 1] - sy) * wrinkleAmt;
          oz = sz + (orig[i * 3 + 2] - sz) * wrinkleAmt;
        } else {
          // 球帽+圆柱内部：用p控制smooth↔orig混合
          const smoothBlend = p; // p=1全smooth, p=0全orig
          ox = orig[i * 3] + (sx - orig[i * 3]) * smoothBlend;
          oy = orig[i * 3 + 1] + (sy - orig[i * 3 + 1]) * smoothBlend;
          oz = orig[i * 3 + 2] + (sz - orig[i * 3 + 2]) * smoothBlend;
        }
      
        const cylH_total = radius * cylH;
        const isCylBottom = oy <= cylH_total * 0.15;
        let newY: number;
        let newX = ox;
        let newZ = oz;
              
        if (isCylBottom) {
          // 底部边缘不动
          newY = oy;
        } else {
          // 其余部分塌陷，保留残余高度模拟残留空气+薄膜刚性
          const t_height = Math.min(1, (oy - cylH_total * 0.15) / (totalHeight - cylH_total * 0.15));
          // 目标高度：保留原高的40-50%（模拟残余空气+刚性）
          const retainRatio = 0.50 - t_height * 0.2; // 底部50%，顶部30%
          
          // 排除区边界不规则：用角度噪声调制排除半径，形成斑块状边界
          const baseExR = 0.6 + ((Math.sin(seed * 13.37) + 1) / 2) * 0.1;
          const angleForExclude = Math.atan2(oz, ox);
          const excludeWobble = Math.sin(angleForExclude * 2.3 + seed * 4.7) * 0.12 + Math.sin(angleForExclude * 3.7 + seed * 8.1) * 0.08;
          const excludeRadius = baseExR + excludeWobble;
          let randomBump = 0;
          if (edgeRatio >= excludeRadius) {
            const angle = Math.atan2(oz, ox);
            // 段数随seed在 3~7 中随机选取
            const freqOptions = [3, 4, 5, 6, 7];
            const freqIdx = Math.abs(Math.round(Math.sin(seed * 9.17) * 10)) % 5;
            const freq = freqOptions[freqIdx];
            // 每段深浅不同：用角度的低频调制信号控制幅度
            const ampMod = 0.5 + 0.5 * Math.sin(angle * 1.3 + seed * 11.7); // 0~1
            randomBump = Math.sin(angle * freq + seed * 5.17) * 0.15 * ampMod;
          } else {
            // 极点区域：环内+环间都有随机高差，法线将被覆盖消除星纹
            const angle = Math.atan2(oz, ox);
            // 瓣数随seed随机，范围更大
            const lobe1 = 1 + ((Math.sin(seed * 5.23) + 1) / 2) * 2; // 1~3
            const lobe2 = 2 + ((Math.sin(seed * 8.91) + 1) / 2) * 3; // 2~5
            randomBump = (
              Math.sin(angle * lobe1 + seed * 3.71) * 0.35 +
              Math.sin(angle * lobe2 + oy * 12 + seed * 7.13) * 0.35 +
              Math.sin(oy * 25 + seed * 2.41) * 0.3
            ) * 0.12;
          }
          
          const targetY = oy * retainRatio * (1 + randomBump);
          newY = oy * (1 - p) + targetY * p;
          // 径向微小收缩（不要太多，保持圆形轮廓）
          const shrinkFactor = 1 - p * t_height * 0.1;
          newX = ox * shrinkFactor;
          newZ = oz * shrinkFactor;
        }
      
        posAttr.setXYZ(
          i,
          (newX + shakeX) * (1 + deflateBulge * Math.sin((newY / totalHeight) * Math.PI)),
          newY,
          (newZ + shakeZ) * (1 + deflateBulge * Math.sin((newY / totalHeight) * Math.PI)),
        );
      }

      posAttr.needsUpdate = true;
      domeGeometry.computeVertexNormals();

      // 极点法线平滑：不规则斑块边界内覆盖法线
      {
        const normalAttr = domeGeometry.attributes.normal;
        const baseRad = radius * 1.2;
        const cylCount = cylinderVertexCount.current;
        const baseExR = 0.6 + ((Math.sin(seed * 13.37) + 1) / 2) * 0.1;
        for (let i = cylCount; i < count; i++) {
          const px = posAttr.getX(i);
          const pz = posAttr.getZ(i);
          const rDist = Math.sqrt(px * px + pz * pz);
          const eRatio = rDist / baseRad;
          const agl = Math.atan2(pz, px);
          const wobble = Math.sin(agl * 2.3 + seed * 4.7) * 0.12 + Math.sin(agl * 3.7 + seed * 8.1) * 0.08;
          const exR = baseExR + wobble;
          if (eRatio < exR) {
            const blend = 1 - eRatio / exR;
            const nx = normalAttr.getX(i) * (1 - blend);
            const ny = normalAttr.getY(i) * (1 - blend) + blend;
            const nz = normalAttr.getZ(i) * (1 - blend);
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len > 0) normalAttr.setXYZ(i, nx / len, ny / len, nz / len);
          }
        }
        normalAttr.needsUpdate = true;
      }

      // 状态推进
      if (phase === 'deflating' && t >= DEFLATE_MS) {
        phaseRef.current = 'deflated';
        elapsedRef.current = 0;
      } else if (phase === 'deflated' && t >= DEFLATED_HOLD_MS) {
        phaseRef.current = 'recovering';
        elapsedRef.current = 0;
        setTimeout(() => audioManager.playRecover(willBeSpecial), 150);
      } else if (phase === 'recovering' && t >= RECOVER_MS) {
        phaseRef.current = 'idle';
        elapsedRef.current = 0;
        // 复位为原始带褶皱形态（已经在上面的循环中通过p=0计算过，直接设置以避免下一帧跳变）
        posAttr.array.set(orig);
        posAttr.needsUpdate = true;
        domeGeometry.computeVertexNormals();
        // 清理牵引/回弹残留状态
        currentOffsetX.current = 0;
        currentOffsetZ.current = 0;
        velocityX.current = 0;
        velocityZ.current = 0;
        isRebounding.current = false;
        onRecover?.();
      }
      return;
    }

    // hover时只拉高圆柱部分，不影响球帽，同时拉高时减少褶纱
    if (phase === 'idle' && originalPositions.current && smoothPositions.current) {
      const targetScale = hovered ? 1.2 / cylH : 1.0;
      hoverScaleY.current += (targetScale - hoverScaleY.current) * Math.min(1, dt * 8);

      if (Math.abs(hoverScaleY.current - 1) > 0.001) {
        const posAttr = domeGeometry.attributes.position;
        const orig = originalPositions.current;
        const smooth = smoothPositions.current;
        const cylCount = cylinderVertexCount.current;
        const cylHt = radius * cylH;
        // hover拉高时也减少褶纹
        const hoverDeform = Math.abs(hoverScaleY.current - 1);
        const wrinkleFade = Math.max(0, 1 - hoverDeform * 2);

        for (let i = 0; i < cylCount; i++) {
          const baseY = smooth[i * 3 + 1] + (orig[i * 3 + 1] - smooth[i * 3 + 1]) * wrinkleFade;
          const newY = baseY * hoverScaleY.current;
          posAttr.setY(i, posAttr.getY(i) + (newY - orig[i * 3 + 1]));
        }
        const yShift = cylHt * (hoverScaleY.current - 1);
        for (let i = cylCount; i < posAttr.count; i++) {
          posAttr.setY(i, posAttr.getY(i) + yShift);
        }
        posAttr.needsUpdate = true;
        domeGeometry.computeVertexNormals();
      }
      return;
    }

  });

  return (
    <group position={position} rotation={rotation}>
      {/* the bubble itself — dome + sealing cap, scaled together */}
      <group ref={groupRef}>
        <mesh
          ref={domeRef}
          geometry={domeGeometry}
          castShadow
          receiveShadow
          onClick={handlePop}
          onPointerDown={handlePointerDown}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(true);
            document.body.style.cursor = 'pointer';
            // 滑动戳破检测
            handlePointerEnter(e as unknown as ThreeEvent<PointerEvent>);
          }}
          onPointerOut={() => {
            setHovered(false);
            document.body.style.cursor = 'auto';
            // 长按模式下离开气泡即取消按压
            if (isPressing.current) {
              isPressing.current = false;
              if (squeezeCtrlRef.current) {
                squeezeCtrlRef.current.stop();
                squeezeCtrlRef.current = null;
              }
            }
          }}
        >
          <meshPhysicalMaterial
            ref={matRef}
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
            attenuationColor={color === 'red' ? specialAttenuationColor : matAttenuationColor}
            attenuationDistance={0.8}
            envMapIntensity={envMapIntensity}
            emissive={color === 'red' ? specialEmissiveColor : emissiveColor}
            emissiveIntensity={color === 'red' ? specialEmissiveInt : emissiveInt}
          >
            <GradientTexture
              attach="map"
              stops={[0, 0.4, 1]}
              colors={lerpGradient || gradient}
            />
          </meshPhysicalMaterial>
        </mesh>

        {/* underside — closes the hemisphere; faintly visible from low angles */}
        <mesh ref={capRef} geometry={capGeometry} position={[0, 0.001, 0]}>
          <meshPhysicalMaterial
            transmission={matTransmission}
            thickness={matThickness}
            roughness={matRoughness}
            ior={matIor}
            metalness={0}
            transparent
            opacity={matOpacity}
            side={THREE.DoubleSide}
            attenuationColor={matAttenuationColor}
            attenuationDistance={1.0}
          />
        </mesh>
      </group>
    </group>
  );
}
