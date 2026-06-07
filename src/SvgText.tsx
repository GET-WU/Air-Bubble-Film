import { useMemo } from 'react';
import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';

interface GlyphData { d: string; width: number }
export interface FontData { upm: number; glyphs: Record<string, GlyphData> }

export function SvgTextMesh({
  text,
  fontData,
  fontSize,
  color,
  position,
  anchorX = 'left',
  anchorY = 'top',
  lineHeight = 1.4,
}: {
  text: string;
  fontData: FontData;
  fontSize: number;
  color: string;
  position: [number, number, number];
  anchorX?: 'left' | 'center' | 'right';
  anchorY?: 'top' | 'middle' | 'bottom';
  lineHeight?: number;
}) {
  const geometry = useMemo(() => {
    const scale = fontSize / fontData.upm;
    const lines = text.split('\n');
    const allShapes: THREE.Shape[] = [];
    const lineWidths: number[] = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      let cursor = 0;
      const lineY = -lineIdx * fontSize * lineHeight;

      for (const ch of line) {
        const glyph = fontData.glyphs[ch];
        if (!glyph || !glyph.d) {
          cursor += (glyph?.width || fontData.upm * 0.3) * scale;
          continue;
        }

        // Parse SVG path data using SVGLoader
        const svgStr = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${glyph.d}"/></svg>`;
        const svgData = new SVGLoader().parse(svgStr);

        for (const path of svgData.paths) {
          const shapes = SVGLoader.createShapes(path);
          for (const shape of shapes) {
            // Transform shape points: scale and translate
            // Font coordinate Y is up, SVG Y is down, SVGLoader already interprets SVG coords
            // We need to flip Y (since font Y-up becomes SVG Y-down in the parser)
            // and apply scale + translation
            const transformed = new THREE.Shape();
            const pts = shape.getPoints();
            const holes = shape.holes;

            if (pts.length > 0) {
              transformed.moveTo(
                pts[0].x * scale + cursor,
                pts[0].y * scale + lineY
              );
              for (let i = 1; i < pts.length; i++) {
                transformed.lineTo(
                  pts[i].x * scale + cursor,
                  pts[i].y * scale + lineY
                );
              }
            }

            // Handle holes
            for (const hole of holes) {
              const holePath = new THREE.Path();
              const holePts = hole.getPoints();
              if (holePts.length > 0) {
                holePath.moveTo(
                  holePts[0].x * scale + cursor,
                  holePts[0].y * scale + lineY
                );
                for (let i = 1; i < holePts.length; i++) {
                  holePath.lineTo(
                    holePts[i].x * scale + cursor,
                    holePts[i].y * scale + lineY
                  );
                }
              }
              transformed.holes.push(holePath);
            }

            allShapes.push(transformed);
          }
        }

        cursor += glyph.width * scale;
      }
      lineWidths.push(cursor);
    }

    if (allShapes.length === 0) return null;

    const totalWidth = Math.max(...lineWidths);
    const totalHeight = lines.length * fontSize * lineHeight;

    // Create extruded geometry with bevel for edge highlights
    const extrudeSettings = {
      depth: fontSize * 0.1,
      bevelEnabled: true,
      bevelThickness: fontSize * 0.03,
      bevelSize: fontSize * 0.02,
      bevelSegments: 4,
    };
    const shapeGeo = new THREE.ExtrudeGeometry(allShapes, extrudeSettings);

    // Compute anchor offset
    let offsetX = 0;
    let offsetY = 0;

    if (anchorX === 'center') offsetX = -totalWidth / 2;
    else if (anchorX === 'right') offsetX = -totalWidth;

    // For anchorY: text renders top-down (first line at y=0, going negative)
    // 'top' means the top of first line aligns with position
    if (anchorY === 'top') offsetY = 0;
    else if (anchorY === 'middle') offsetY = totalHeight / 2 - fontSize * 0.5;
    else if (anchorY === 'bottom') offsetY = totalHeight - fontSize;

    // Per-line X offset for non-left anchor
    if (anchorX !== 'left') {
      const posArr = shapeGeo.attributes.position;
      // We need to offset each line differently for center/right alignment
      // For simplicity with merged geometry, apply uniform offset based on max width
      for (let i = 0; i < posArr.count; i++) {
        posArr.setX(i, posArr.getX(i) + offsetX);
        posArr.setY(i, posArr.getY(i) + offsetY);
      }
      posArr.needsUpdate = true;
    } else if (offsetY !== 0) {
      const posArr = shapeGeo.attributes.position;
      for (let i = 0; i < posArr.count; i++) {
        posArr.setY(i, posArr.getY(i) + offsetY);
      }
      posArr.needsUpdate = true;
    }

    return shapeGeo;
  }, [text, fontData, fontSize, anchorX, anchorY, lineHeight]);

  if (!geometry) return null;

  return (
    <mesh position={position} geometry={geometry}>
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>
  );
}
