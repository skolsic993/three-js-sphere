import * as THREE from "three";

/* ------------------------------------------------------------------ */
/* Triplanar sampling: project the texture from all three axes and     */
/* blend by the surface normal. Sidesteps UVs entirely.                */
/* ------------------------------------------------------------------ */
const TRIPLANAR_GLSL = /* glsl */ `
  /* Blend weights. Higher sharpness = tighter transitions between the three
     projections; too high and the seams turn hard, too low and everything
     looks like three overlapping ghosts. 4-8 is the useful range. */
  vec3 triBlend(vec3 n, float sharpness) {
    vec3 w = pow(abs(n), vec3(sharpness));
    return w / (w.x + w.y + w.z);
  }

  vec4 triSample(sampler2D tex, vec3 p, vec3 w, float s) {
    return texture2D(tex, p.yz * s) * w.x
         + texture2D(tex, p.xz * s) * w.y
         + texture2D(tex, p.xy * s) * w.z;
  }

  /* Normal maps can't just be averaged - each projection's tangent space
     points a different way. This is the "whiteout blend": reorient each
     sample against the geometric normal, then swizzle into object space. */
  vec3 triNormal(sampler2D tex, vec3 p, vec3 n, vec3 w, float s, float strength) {
    vec3 nx = texture2D(tex, p.yz * s).xyz * 2.0 - 1.0;
    vec3 ny = texture2D(tex, p.xz * s).xyz * 2.0 - 1.0;
    vec3 nz = texture2D(tex, p.xy * s).xyz * 2.0 - 1.0;

    nx.xy *= strength;
    ny.xy *= strength;
    nz.xy *= strength;

    nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
    ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
    nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);

    return normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
  }
`;

function configure(texture, renderer, srgb) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // Colour data needs sRGB decoding. Normal and roughness are raw numbers,
  // NOT colours - decoding them would corrupt the values.
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return texture;
}

/**
 * Loads the three maps we actually use. `ao` is optional - grab the AO row
 * from Poly Haven later if you want crevice darkening.
 */
export function loadRockTextures(renderer, path = "/textures", res = "2k") {
  const loader = new THREE.TextureLoader();
  return {
    diffuse: configure(
      loader.load(`${path}/dark_rock_diff_${res}.jpg`),
      renderer,
      true,
    ),
    normal: configure(
      loader.load(`${path}/dark_rock_nor_gl_${res}.jpg`),
      renderer,
      false,
    ),
    roughness: configure(
      loader.load(`${path}/dark_rock_rough_${res}.jpg`),
      renderer,
      false,
    ),
    ao: null,
  };
}

/**
 * Applies triplanar-mapped textures to an existing MeshStandardMaterial.
 */
export function applyRockSurface(material, textures, options = {}) {
  const settings = {
    texScale: 1.6, // repeats per world unit. rock radius is ~1
    normalStrength: 1.0,
    blendSharpness: 6.0,
    aoIntensity: 1.0, // only used if textures.ao was supplied
    ...options,
  };

  // The textures supply colour and roughness, so the material's own values
  // must be neutral or they'll multiply against them and go black.
  material.color.set(0xffffff);
  material.roughness = 1.0;
  material.flatShading = false;

  const hasAo = Boolean(textures.ao);

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uDiffMap: {value: textures.diffuse},
      uNormMap: {value: textures.normal},
      uRoughMap: {value: textures.roughness},
      uTexScale: {value: settings.texScale},
      uNormalStrength: {value: settings.normalStrength},
      uBlendSharpness: {value: settings.blendSharpness},
    });

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vObjPos;
         varying vec3 vObjNormal;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vObjPos = position;
         vObjNormal = normal;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vObjPos;
         varying vec3 vObjNormal;
         uniform sampler2D uDiffMap;
         uniform sampler2D uNormMap;
         uniform sampler2D uRoughMap;
         uniform float uTexScale;
         uniform float uNormalStrength;
         uniform float uBlendSharpness;
         // Three declares this in the vertex prefix only, so the fragment
         // stage needs its own declaration. Same name + type = shared storage,
         // and the renderer populates any program where it is active.
         uniform mat3 normalMatrix;
         ${TRIPLANAR_GLSL}`,
      )
      // Blend weights are computed once here and reused by every chunk below,
      // since map_fragment runs before all of them inside the same main().
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
         vec3 objN = normalize(vObjNormal);
         vec3 triW = triBlend(objN, uBlendSharpness);
         diffuseColor.rgb *= triSample(uDiffMap, vObjPos, triW, uTexScale).rgb;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
         roughnessFactor *= triSample(uRoughMap, vObjPos, triW, uTexScale).g;`,
      )
      .replace(
        "#include <normal_fragment_begin>",
        `#include <normal_fragment_begin>
         vec3 detailN = triNormal(
           uNormMap, vObjPos, objN, triW, uTexScale, uNormalStrength
         );
         // triNormal works in object space; normalMatrix takes it to view
         // space, which is where the rest of the lighting maths expects it.
         normal = normalize(normalMatrix * detailN);`,
      );

    if (hasAo) {
      shader.uniforms.uAoMap = {value: textures.ao};
      shader.uniforms.uAoIntensity = {value: settings.aoIntensity};

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "uniform float uBlendSharpness;",
          `uniform float uBlendSharpness;
           uniform sampler2D uAoMap;
           uniform float uAoIntensity;`,
        )
        // This chunk sits AFTER the lighting loop, so the indirect terms are
        // already accumulated and we're attenuating ambient + environment
        // light only - which is what occlusion physically does.
        .replace(
          "#include <aomap_fragment>",
          `#include <aomap_fragment>
           float ao = mix(1.0, triSample(uAoMap, vObjPos, triW, uTexScale).r, uAoIntensity);
           reflectedLight.indirectDiffuse *= ao;
           reflectedLight.indirectSpecular *= ao;`,
        );
    }

    material.userData.shader = shader;
  };

  material.needsUpdate = true;
  return material;
}
