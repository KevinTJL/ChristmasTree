import { useState, useMemo, useRef, useEffect, Suspense } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import {
  OrbitControls,
  Environment,
  PerspectiveCamera,
  shaderMaterial,
  Float,
  Stars,
  Sparkles,
  useTexture,
  Text
} from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { MathUtils } from 'three';
import * as random from 'maath/random';
import { GestureRecognizer, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";

// --- 动态生成照片列表 (top.jpg + 1.jpg 到 31.jpg) ---
const TOTAL_NUMBERED_PHOTOS = 28;
// 修改：将 top.jpg 加入到数组开头
const bodyPhotoPaths = [
  '/photos/top.jpg',
  ...Array.from({ length: TOTAL_NUMBERED_PHOTOS }, (_, i) => `/photos/${i + 1}.jpg`)
];

// --- 视觉配置 ---
const CONFIG = {
  colors: {
    emerald: '#6A0572', // 蓝紫色主体
    gold: '#FFD700',
    silver: '#ECEFF1',
    red: '#E31937',     // 亮红色
    green: '#C41E3A',   // 深红
    white: '#FFFFFF',   // 纯白色
    warmLight: '#FFD54F',
    lights: ['#FF0000', '#9D4EDD', '#3A0CA3', '#E31937'], // 彩灯 - 红色和紫色
    // 拍立得边框颜色池 (红色和紫色系)
    borders: ['#FFE5E5', '#F3E5F5', '#E8D7F1', '#FFB3BA', '#D4A5FF', '#E0B3FF', '#FFCCCC'],
    // 圣诞元素颜色 - 红色和紫色
    giftColors: ['#E31937', '#FFD700', '#9D4EDD', '#C41E3A'],
    candyColors: ['#FF0000', '#FFFFFF']
  },
  counts: {
    foliage: 20000,
    ornaments: 58,   // 拍立得照片数量
    elements: 1200,    // 圣诞元素数量（增加数量以维持体积密度）
    lights: 400       // 彩灯数量
  },
  tree: { height: 28, radius: 11 }, // 放大树体尺寸
  photos: {
    // top 属性不再需要，因为已经移入 body
    body: bodyPhotoPaths
  }
};

// --- Shader Material (Foliage) ---
const FoliageMaterial = shaderMaterial(
  { uTime: 0, uColor: new THREE.Color(CONFIG.colors.emerald), uProgress: 0 },
  `uniform float uTime; uniform float uProgress; attribute vec3 aTargetPos; attribute float aRandom;
  varying vec2 vUv; varying float vMix;
  float cubicInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 0.5 * pow(2.0 * t - 2.0, 3.0) + 1.0; }
  void main() {
    vUv = uv;
    vec3 noise = vec3(sin(uTime * 1.5 + position.x), cos(uTime + position.y), sin(uTime * 1.5 + position.z)) * 0.15;
    float t = cubicInOut(uProgress);
    vec3 finalPos = mix(position, aTargetPos + noise, t);
    vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
    gl_PointSize = (60.0 * (1.0 + aRandom)) / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    vMix = t;
  }`,
  `uniform vec3 uColor; varying float vMix;
  void main() {
    float r = distance(gl_PointCoord, vec2(0.5)); if (r > 0.5) discard;
    vec3 finalColor = mix(uColor * 0.3, uColor * 1.2, vMix);
    gl_FragColor = vec4(finalColor, 1.0);
  }`
);
extend({ FoliageMaterial });

// --- Component: Snow Field ---
const Snow = () => {
  const count = 1800;
  const { positions, speeds } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 160;      // x
      positions[i * 3 + 1] = Math.random() * 90;           // y
      positions[i * 3 + 2] = (Math.random() - 0.5) * 160;  // z
      speeds[i] = 0.6 + Math.random() * 0.9; // 下落速度
    }
    return { positions, speeds };
  }, []);

  const positionsRef = useRef<THREE.BufferAttribute>(null);

  useFrame((_, delta) => {
    const attr = positionsRef.current;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const idx = i * 3 + 1; // y 分量
      arr[idx] -= speeds[i] * delta * 10;
      if (arr[idx] < -20) {
        arr[idx] = 90;
        arr[idx - 1] = (Math.random() - 0.5) * 160; // 重新随机 x
        arr[idx + 1] = (Math.random() - 0.5) * 160; // 重新随机 z
      }
    }
    attr.needsUpdate = true;
  });

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute
          ref={positionsRef}
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        color={CONFIG.colors.white}
        size={0.6}
        sizeAttenuation
        transparent
        opacity={0.8}
        depthWrite={false}
      />
    </points>
  );
};

// --- Helper: Tree Shape ---
const getTreePosition = () => {
  const h = CONFIG.tree.height; const rBase = CONFIG.tree.radius;
  const y = (Math.random() * h) - (h / 2); const normalizedY = (y + (h/2)) / h;
  const currentRadius = rBase * (1 - normalizedY); const theta = Math.random() * Math.PI * 2;
  const r = Math.random() * currentRadius;
  return [r * Math.cos(theta), y, r * Math.sin(theta)];
};

// --- Component: Foliage ---
const Foliage = ({ state, color }: { state: 'CHAOS' | 'FORMED', color: string }) => {
  const materialRef = useRef<any>(null);
  const groupRef = useRef<THREE.Group>(null);
  const { positions, targetPositions, randoms } = useMemo(() => {
    const count = CONFIG.counts.foliage;
    const positions = new Float32Array(count * 3); const targetPositions = new Float32Array(count * 3); const randoms = new Float32Array(count);
    const spherePoints = random.inSphere(new Float32Array(count * 3), { radius: 25 }) as Float32Array;
    for (let i = 0; i < count; i++) {
      positions[i*3] = spherePoints[i*3]; positions[i*3+1] = spherePoints[i*3+1]; positions[i*3+2] = spherePoints[i*3+2];
      const [tx, ty, tz] = getTreePosition();
      targetPositions[i*3] = tx; targetPositions[i*3+1] = ty; targetPositions[i*3+2] = tz;
      randoms[i] = Math.random();
    }
    return { positions, targetPositions, randoms };
  }, []);
  useFrame((rootState, delta) => {
    if (materialRef.current) {
      materialRef.current.uTime = rootState.clock.elapsedTime;
      materialRef.current.uColor = new THREE.Color(color);
      const targetProgress = state === 'FORMED' ? 1 : 0;
      materialRef.current.uProgress = MathUtils.damp(materialRef.current.uProgress, targetProgress, 1.5, delta);
    }
    if (groupRef.current && state === 'CHAOS') {
      groupRef.current.rotation.y += delta * 0.4; // 混沌态缓慢自旋
    }
  });
  return (
    <group ref={groupRef}>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-aTargetPos" args={[targetPositions, 3]} />
          <bufferAttribute attach="attributes-aRandom" args={[randoms, 1]} />
        </bufferGeometry>
        {/* @ts-ignore */}
        <foliageMaterial ref={materialRef} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </points>
    </group>
  );
};

// --- Component: Photo Ornaments (Double-Sided Polaroid) ---
const PhotoOrnaments = ({ state, zoomActive, zoomIndex, zoomDir }: { state: 'CHAOS' | 'FORMED', zoomActive: boolean, zoomIndex: number, zoomDir: 'left' | 'right' | 'up' | 'down' | null }) => {
  const textures = useTexture(CONFIG.photos.body);
  const count = CONFIG.counts.ornaments;
  const groupRef = useRef<THREE.Group>(null);

  const borderGeometry = useMemo(() => new THREE.PlaneGeometry(0.9, 1.1), []);
  const photoGeometry = useMemo(() => new THREE.PlaneGeometry(0.75, 0.75), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map((_, i) => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*70, (Math.random()-0.5)*70, (Math.random()-0.5)*70);
      const h = CONFIG.tree.height;
      const yFrac = Math.pow(Math.random(), 1.6) * 0.7; // 底部密集，顶部稀疏，并限制最高 70% 高度
      const y = yFrac * h - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.5;
      const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));
      // 将照片从树体表面外移，呈悬挂/垂直插入状态
      const dir = new THREE.Vector3(targetPos.x, 0, targetPos.z);
      if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
      dir.normalize();
      targetPos.addScaledVector(dir, 0.8);
      targetPos.y -= 0.3;

      const isBig = Math.random() < 0.2;
      const baseScale = isBig ? 1.5 : 0.55 + Math.random() * 0.35;
      const weight = 0.8 + Math.random() * 1.2;
      const borderColor = CONFIG.colors.borders[Math.floor(Math.random() * CONFIG.colors.borders.length)];

      const rotationSpeed = {
        x: (Math.random() - 0.5) * 1.0,
        y: (Math.random() - 0.5) * 1.0,
        z: (Math.random() - 0.5) * 1.0
      };
      const chaosRotation = new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);

      return {
        chaosPos, targetPos, scale: baseScale, weight,
        textureIndex: i % textures.length,
        borderColor,
        currentPos: chaosPos.clone(),
        chaosRotation,
        rotationSpeed,
        wobbleOffset: Math.random() * 10,
        wobbleSpeed: 0.5 + Math.random() * 0.5
      };
    });
  }, [textures, count]);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;

    if (!isFormed) {
      groupRef.current.rotation.y += delta * 0.25; // 混沌态整体旋转
    }

    groupRef.current.children.forEach((group, i) => {
      const objData = data[i];
      let target = isFormed ? objData.targetPos : objData.chaosPos;
      if (zoomActive && i === zoomIndex) {
        const front = new THREE.Vector3(0, CONFIG.tree.height * 0.05, 14);
        const offset = new THREE.Vector3(
          zoomDir === 'left' ? -6 : zoomDir === 'right' ? 6 : 0,
          zoomDir === 'up' ? 5 : zoomDir === 'down' ? -2 : 0,
          0
        );
        target = front.add(offset);
      }

      objData.currentPos.lerp(target, delta * (isFormed ? 0.8 * objData.weight : 0.5));
      group.position.copy(objData.currentPos);

      if (isFormed) {
         const targetLookPos = new THREE.Vector3(group.position.x * 2, group.position.y + 0.5, group.position.z * 2);
         group.lookAt(targetLookPos);

         const wobbleX = Math.sin(time * objData.wobbleSpeed + objData.wobbleOffset) * 0.05;
         const wobbleZ = Math.cos(time * objData.wobbleSpeed * 0.8 + objData.wobbleOffset) * 0.05;
         group.rotation.x += wobbleX;
         group.rotation.z += wobbleZ;

      } else {
         group.rotation.x += delta * objData.rotationSpeed.x;
         group.rotation.y += delta * objData.rotationSpeed.y;
         group.rotation.z += delta * objData.rotationSpeed.z;
      }
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => (
        <group key={i} scale={[obj.scale, obj.scale, obj.scale]} rotation={state === 'CHAOS' ? obj.chaosRotation : [0,0,0]}>
          {/* 正面 */}
          <group position={[0, 0, 0.015]}>
            <mesh geometry={photoGeometry}>
              <meshStandardMaterial
                map={textures[obj.textureIndex]}
                roughness={0.5} metalness={0}
                emissive={CONFIG.colors.white} emissiveMap={textures[obj.textureIndex]} emissiveIntensity={1.0}
                side={THREE.FrontSide}
              />
            </mesh>
            <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]}>
              <meshStandardMaterial color={obj.borderColor} roughness={0.9} metalness={0} side={THREE.FrontSide} />
            </mesh>
            {zoomActive && i === 0 && (
              <Sparkles count={50} speed={1.8} scale={4} size={7} color={CONFIG.colors.gold} opacity={0.8} />
            )}
          </group>
          {/* 背面 */}
          <group position={[0, 0, -0.015]} rotation={[0, Math.PI, 0]}>
            <mesh geometry={photoGeometry}>
              <meshStandardMaterial
                map={textures[obj.textureIndex]}
                roughness={0.5} metalness={0}
                emissive={CONFIG.colors.white} emissiveMap={textures[obj.textureIndex]} emissiveIntensity={1.0}
                side={THREE.FrontSide}
              />
            </mesh>
            <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]}>
              <meshStandardMaterial color={obj.borderColor} roughness={0.9} metalness={0} side={THREE.FrontSide} />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  );
};

// --- Component: Christmas Elements ---
const ChristmasElements = ({ state, color, zoomActive }: { state: 'CHAOS' | 'FORMED', color: string, zoomActive: boolean }) => {
  const count = CONFIG.counts.elements;
  const groupRef = useRef<THREE.Group>(null);

  const boxGeometry = useMemo(() => new THREE.BoxGeometry(0.5, 0.5, 0.5), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height;
      const y = (Math.random() * h) - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) * 0.95;
      const theta = Math.random() * Math.PI * 2;

      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const scale = 0.55 + Math.random() * 0.25; // 更小的方块
      const rotationSpeed = { x: (Math.random()-0.5)*2.0, y: (Math.random()-0.5)*2.0, z: (Math.random()-0.5)*2.0 };
      return { chaosPos, targetPos, scale, currentPos: chaosPos.clone(), chaosRotation: new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI), rotationSpeed };
    });
  }, [boxGeometry]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    if (!isFormed) {
      groupRef.current.rotation.y += delta * 0.25; // 混沌态整体自转，方块随动
    }
    groupRef.current.children.forEach((child, i) => {
      const mesh = child as THREE.Mesh;
      const objData = data[i];
      let target = isFormed ? objData.targetPos : objData.chaosPos;
      if (zoomActive && i < 5) {
        target = objData.chaosPos.clone().multiplyScalar(0.7); // 轻微收拢以配合近景
      }
      objData.currentPos.lerp(target, delta * 1.5);
      mesh.position.copy(objData.currentPos);
      mesh.rotation.x += delta * objData.rotationSpeed.x; mesh.rotation.y += delta * objData.rotationSpeed.y; mesh.rotation.z += delta * objData.rotationSpeed.z;
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => (
        <mesh key={i} scale={[obj.scale, obj.scale, obj.scale]} geometry={boxGeometry} rotation={obj.chaosRotation}>
          <meshStandardMaterial color={color} roughness={0.3} metalness={0.4} emissive={color} emissiveIntensity={0.25} />
        </mesh>
      ))}
    </group>
  );
};

// --- Component: Fairy Lights ---
const FairyLights = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.lights;
  const groupRef = useRef<THREE.Group>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.8, 8, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2); const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.3; const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));
      const color = CONFIG.colors.lights[Math.floor(Math.random() * CONFIG.colors.lights.length)];
      const speed = 2 + Math.random() * 3;
      return { chaosPos, targetPos, color, speed, currentPos: chaosPos.clone(), timeOffset: Math.random() * 100 };
    });
  }, []);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;
    groupRef.current.children.forEach((child, i) => {
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 2.0);
      const mesh = child as THREE.Mesh;
      mesh.position.copy(objData.currentPos);
      const intensity = (Math.sin(time * objData.speed + objData.timeOffset) + 1) / 2;
      if (mesh.material) { (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = isFormed ? 3 + intensity * 4 : 0; }
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => ( <mesh key={i} scale={[0.15, 0.15, 0.15]} geometry={geometry}>
          <meshStandardMaterial color={obj.color} emissive={obj.color} emissiveIntensity={0} toneMapped={false} />
        </mesh> ))}
    </group>
  );
};

// --- Component: Top Star (No Photo, Pure Gold 3D Star) ---
const TopStar = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const groupRef = useRef<THREE.Group>(null);

  const starShape = useMemo(() => {
    const shape = new THREE.Shape();
    const outerRadius = 1.3; const innerRadius = 0.7; const points = 5;
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      i === 0 ? shape.moveTo(radius*Math.cos(angle), radius*Math.sin(angle)) : shape.lineTo(radius*Math.cos(angle), radius*Math.sin(angle));
    }
    shape.closePath();
    return shape;
  }, []);

  const starGeometry = useMemo(() => {
    return new THREE.ExtrudeGeometry(starShape, {
      depth: 0.4, // 增加一点厚度
      bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3,
    });
  }, [starShape]);

  // 纯金材质
  const goldMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: CONFIG.colors.gold,
    emissive: CONFIG.colors.gold,
    emissiveIntensity: 1.5, // 适中亮度，既发光又有质感
    roughness: 0.1,
    metalness: 1.0,
  }), []);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.5;
      const targetScale = state === 'FORMED' ? 1 : 0;
      groupRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), delta * 3);
    }
  });

  return (
    <group ref={groupRef} position={[0, CONFIG.tree.height / 2 + 1.8, 0]}>
      <Float speed={2} rotationIntensity={0.2} floatIntensity={0.2}>
        <mesh geometry={starGeometry} material={goldMaterial} />
      </Float>
    </group>
  );
};

// --- Main Scene Experience ---
const Experience = ({ sceneState, rotationSpeed, activeColor, zoomActive, zoomIndex, zoomDir, ctxLost }: { sceneState: 'CHAOS' | 'FORMED', rotationSpeed: number, activeColor: string, zoomActive: boolean, zoomIndex: number, zoomDir: 'left' | 'right' | 'up' | 'down' | null, ctxLost: boolean }) => {
  const controlsRef = useRef<any>(null);
  const sceneGroupRef = useRef<THREE.Group>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);

  useFrame((_, delta) => {
    if (controlsRef.current) {
      controlsRef.current.setAzimuthalAngle(controlsRef.current.getAzimuthalAngle() + rotationSpeed);
      controlsRef.current.update();
    }
    // 树体在聚合时缓慢自旋
    if (sceneGroupRef.current && sceneState === 'FORMED') {
      sceneGroupRef.current.rotation.y += delta * (rotationSpeed !== 0 ? rotationSpeed * 8 : 0.12);
    }
    // 视角随聚散自动远近，便于看清散开的照片
    if (cameraRef.current) {
      const targetZ = sceneState === 'CHAOS' ? 32 : 72; // CHAOS 更近景
      const targetY = sceneState === 'CHAOS' ? 6 : 10;
      if (sceneState === 'CHAOS') {
        cameraRef.current.position.z = targetZ;
        cameraRef.current.position.y = targetY;
      } else {
        cameraRef.current.position.z = MathUtils.damp(cameraRef.current.position.z, targetZ, 2.5, delta);
        cameraRef.current.position.y = MathUtils.damp(cameraRef.current.position.y, targetY, 2.5, delta);
      }
    }
  });

  return (
    <>
      <PerspectiveCamera ref={cameraRef} makeDefault position={[0, 10, 72]} fov={45} />
      <OrbitControls ref={controlsRef} enablePan={false} enableZoom={true} minDistance={30} maxDistance={120} autoRotate={rotationSpeed === 0 && sceneState === 'FORMED'} autoRotateSpeed={0.3} maxPolarAngle={Math.PI / 1.7} />

      <color attach="background" args={['#000300']} />
      <Stars radius={120} depth={60} count={5000} factor={4} saturation={0} fade speed={1} />
      <Snow />
      <Environment preset="night" background={false} />

      <ambientLight intensity={0.4} color="#330011" />
      <pointLight position={[30, 30, 30]} intensity={100} color="#E31937" />
      <pointLight position={[-30, 10, -30]} intensity={50} color="#9D4EDD" />
      <pointLight position={[0, -20, 10]} intensity={30} color="#ffffff" />

      <group ref={sceneGroupRef} position={[0, -7, 0]}>
        <Foliage state={sceneState} color={activeColor} />
        <Suspense fallback={null}>
           <PhotoOrnaments state={sceneState} zoomActive={zoomActive} zoomIndex={zoomIndex} zoomDir={zoomDir} />
           <ChristmasElements state={sceneState} color={activeColor} zoomActive={zoomActive} />
           <FairyLights state={sceneState} />
           <TopStar state={sceneState} />
        </Suspense>
        <Sparkles count={600} scale={50} size={8} speed={0.4} opacity={0.4} color={CONFIG.colors.silver} />
        <Text
          position={[0, CONFIG.tree.height / 2 + 6, 0]}
          fontSize={3}
          color={activeColor}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.08}
          outlineColor="#000000"
        >
          MERRY CHRISTMAS
        </Text>
      </group>

      {!ctxLost && (
        <EffectComposer multisampling={0}>
          <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.1} intensity={1.5} radius={0.5} mipmapBlur />
          <Vignette eskil={false} offset={0.1} darkness={1.2} />
        </EffectComposer>
      )}
    </>
  );
};

// --- Gesture Controller ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GestureController = ({ onGesture, onMove, onStatus, onColorCycle, onPhotoZoom, debugMode }: any) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastColorRef = useRef(0);

  useEffect(() => {
    let gestureRecognizer: GestureRecognizer;
    let requestRef: number;

    const setup = async () => {
      onStatus("DOWNLOADING AI...");
      try {
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
        gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });
        onStatus("REQUESTING CAMERA...");
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play();
            onStatus("AI READY: SHOW HAND");
            predictWebcam();
          }
        } else {
            onStatus("ERROR: CAMERA PERMISSION DENIED");
        }
      } catch (err: any) {
        onStatus(`ERROR: ${err.message || 'MODEL FAILED'}`);
      }
    };

    const predictWebcam = () => {
      if (gestureRecognizer && videoRef.current && canvasRef.current) {
        if (videoRef.current.videoWidth > 0) {
            const results = gestureRecognizer.recognizeForVideo(videoRef.current, Date.now());
            const ctx = canvasRef.current.getContext("2d");
            if (ctx && debugMode) {
                ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
                canvasRef.current.width = videoRef.current.videoWidth; canvasRef.current.height = videoRef.current.videoHeight;
                if (results.landmarks) for (const landmarks of results.landmarks) {
                        const drawingUtils = new DrawingUtils(ctx);
                        drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: "#FFD700", lineWidth: 2 });
                        drawingUtils.drawLandmarks(landmarks, { color: "#FF0000", lineWidth: 1 });
                }
            } else if (ctx && !debugMode) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

              if (results.gestures.length > 0) {
              const name = results.gestures[0][0].categoryName; const score = results.gestures[0][0].score;
                if (score > 0.4) {
                  if (name === "Open_Palm") onGesture("CHAOS");
                  if (name === "Closed_Fist") onGesture("FORMED");
                  if (name === "Victory" || name === "Peace" || name === "V_Sign") {
                    const now = performance.now();
                    if (now - lastColorRef.current > 800) {
                     onColorCycle();
                     lastColorRef.current = now;
                    }
                  }
                  if (debugMode) onStatus(`DETECTED: ${name}`);
                }
              if (results.landmarks.length > 0) {
                const lm = results.landmarks[0];
                const speed = (0.5 - lm[0].x) * 0.15;
                onMove(Math.abs(speed) > 0.01 ? speed : 0);

                // 手指捏住：大拇指与食指距离
                const pinchDist = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y, lm[4].z - lm[8].z);
                const pinch = pinchDist < 0.05;

                let dir: 'left' | 'right' | 'up' | 'down' | null = null;
                const dx = lm[8].x - lm[4].x;
                const dy = lm[8].y - lm[4].y;
                if (Math.abs(dx) > Math.abs(dy)) {
                  dir = dx > 0 ? 'right' : 'left';
                } else {
                  dir = dy > 0 ? 'down' : 'up';
                }

                onPhotoZoom(pinch, pinch ? dir : null);
              }
            } else { onMove(0); if (debugMode) onStatus("AI READY: NO HAND"); }
        }
        requestRef = requestAnimationFrame(predictWebcam);
      }
    };
    setup();
    return () => cancelAnimationFrame(requestRef);
  }, [onGesture, onMove, onStatus, onColorCycle, onPhotoZoom, debugMode]);

  return (
    <>
      <video ref={videoRef} style={{ opacity: debugMode ? 0.6 : 0, position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', zIndex: debugMode ? 100 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', height: debugMode ? 'auto' : '1px', zIndex: debugMode ? 101 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} />
    </>
  );
};

// --- App Entry ---
export default function GrandTreeApp() {
  const [sceneState, setSceneState] = useState<'CHAOS' | 'FORMED'>('FORMED');
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [aiStatus, setAiStatus] = useState("INITIALIZING...");
  const [debugMode, setDebugMode] = useState(false);
  const [ctxLost, setCtxLost] = useState(false);
  const mainColors = ['#E31937', '#1E88E5', '#F06292', '#2E7D32', '#FFFFFF'];
  const [colorIndex, setColorIndex] = useState(0);
  const activeColor = mainColors[colorIndex];
  const [photoZoom, setPhotoZoom] = useState(false);
  const [photoZoomDir, setPhotoZoomDir] = useState<'left' | 'right' | 'up' | 'down' | null>(null);
  const [photoZoomIndex, setPhotoZoomIndex] = useState(0);

  const handleCycleColor = () => setColorIndex((i) => (i + 1) % mainColors.length);

  const dirToIndex = (dir: 'left' | 'right' | 'up' | 'down' | null) => {
    if (dir === 'left') return 1;
    if (dir === 'right') return 0;
    if (dir === 'up') return 2;
    if (dir === 'down') return 3;
    return 0;
  };

  const handlePhotoZoom = (active: boolean, dir: 'left' | 'right' | 'up' | 'down' | null) => {
    setPhotoZoom(active);
    if (active && dir) {
      setPhotoZoomDir(dir);
      setPhotoZoomIndex(dirToIndex(dir));
    } else if (!active) {
      setPhotoZoomDir(null);
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
      <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
        <Canvas
          dpr={[1, 1.5]}
          gl={{
            toneMapping: THREE.ReinhardToneMapping,
            antialias: true,
            powerPreference: 'high-performance',
            stencil: false,
            depth: true,
            preserveDrawingBuffer: false,
          }}
          shadows
          onCreated={({ gl }) => {
            const canvas = gl.getContext().canvas;
            const handleLoss = (e: Event) => {
              e.preventDefault();
              setCtxLost(true);
            };
            const handleRestore = () => {
              setCtxLost(false);
            };
            canvas.addEventListener('webglcontextlost', handleLoss, false);
            canvas.addEventListener('webglcontextrestored', handleRestore, false);
          }}
        >
            <Experience sceneState={sceneState} rotationSpeed={rotationSpeed} activeColor={activeColor} zoomActive={photoZoom} zoomIndex={photoZoomIndex} zoomDir={photoZoomDir} ctxLost={ctxLost} />
        </Canvas>
      </div>
      <GestureController onGesture={setSceneState} onMove={setRotationSpeed} onStatus={setAiStatus} onColorCycle={handleCycleColor} onPhotoZoom={handlePhotoZoom} debugMode={debugMode} />

      {/* UI - Stats */}
      <div style={{ position: 'absolute', bottom: '30px', left: '40px', color: '#888', zIndex: 10, fontFamily: 'sans-serif', userSelect: 'none' }}>
        <div style={{ marginBottom: '15px' }}>
          <p style={{ fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '4px' }}>Memories</p>
          <p style={{ fontSize: '24px', color: '#FFD700', fontWeight: 'bold', margin: 0 }}>
            {CONFIG.counts.ornaments.toLocaleString()} <span style={{ fontSize: '10px', color: '#555', fontWeight: 'normal' }}>POLAROIDS</span>
          </p>
        </div>
        <div>
          <p style={{ fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '4px' }}>Foliage</p>
          <p style={{ fontSize: '24px', color: '#9D4EDD', fontWeight: 'bold', margin: 0 }}>
            {(CONFIG.counts.foliage / 1000).toFixed(0)}K <span style={{ fontSize: '10px', color: '#555', fontWeight: 'normal' }}>PURPLE NEEDLES</span>
          </p>
        </div>
      </div>

      {/* UI - Buttons */}
      <div style={{ position: 'absolute', bottom: '30px', right: '40px', zIndex: 10, display: 'flex', gap: '10px' }}>
        <button onClick={() => setDebugMode(!debugMode)} style={{ padding: '12px 15px', backgroundColor: debugMode ? '#FFD700' : 'rgba(0,0,0,0.5)', border: '1px solid #FFD700', color: debugMode ? '#000' : '#FFD700', fontFamily: 'sans-serif', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
           {debugMode ? 'HIDE DEBUG' : '🛠 DEBUG'}
        </button>
        <button onClick={() => setSceneState(s => s === 'CHAOS' ? 'FORMED' : 'CHAOS')} style={{ padding: '12px 30px', backgroundColor: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255, 215, 0, 0.5)', color: '#FFD700', fontFamily: 'serif', fontSize: '14px', fontWeight: 'bold', letterSpacing: '3px', textTransform: 'uppercase', cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
           {sceneState === 'CHAOS' ? 'Assemble Tree' : 'Disperse'}
        </button>
      </div>

      {/* UI - AI Status */}
      <div style={{ position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)', color: aiStatus.includes('ERROR') ? '#FF0000' : 'rgba(255, 215, 0, 0.4)', fontSize: '10px', letterSpacing: '2px', zIndex: 10, background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: '4px' }}>
        {aiStatus}
      </div>
    </div>
  );
}