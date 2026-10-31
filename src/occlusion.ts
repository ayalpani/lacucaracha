import { Matrix4, Vector2, type Material, type Texture } from 'three';

/** Shared uniforms: one depth texture for all roach materials. */
export const occlusionUniforms = {
  uDepthTex: { value: null as Texture | null },
  uDepthUv: { value: new Matrix4() },
  uDepthOn: { value: 0 },
  uResolution: { value: new Vector2(1, 1) },
};

/**
 * Patch a material so fragments behind real-world geometry (per the ARCore
 * depth map) are discarded: a roach walking behind a chair leg disappears.
 */
export function withOcclusion<T extends Material>(material: T): T {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, occlusionUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying float vOccViewZ;\nvoid main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vOccViewZ = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `varying float vOccViewZ;
uniform sampler2D uDepthTex;
uniform mat4 uDepthUv;
uniform float uDepthOn;
uniform vec2 uResolution;
void main() {
  if (uDepthOn > 0.5) {
    vec2 viewUv = gl_FragCoord.xy / uResolution;
    viewUv.y = 1.0 - viewUv.y; // normalized view coords have y down
    vec2 depthUv = (uDepthUv * vec4(viewUv, 0.0, 1.0)).xy;
    float real = texture2D(uDepthTex, depthUv).r;
    // Small tolerance so roaches on a surface aren't eaten by depth noise.
    if (real > 0.05 && vOccViewZ > real + 0.04 + 0.02 * real) discard;
  }`,
      );
  };
  // Distinct program cache key so three doesn't reuse an unpatched program.
  material.customProgramCacheKey = () => 'occlusion';
  return material;
}
