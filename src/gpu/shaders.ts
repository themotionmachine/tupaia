// GLSL ES 3.00 programs. All colors are premultiplied; blending is ONE, ONE_MINUS_SRC_ALPHA.
const header = "#version 300 es\nprecision highp float;\n";

// Stencil-then-cover fills: the same fan is drawn twice (stencil pass, then cover with stencil zeroing).
export const fill = {
  vs: `${header}
in vec2 a_position;
uniform mat3 u_matrix;
out vec2 v_world;
void main() {
  v_world = a_position;
  gl_Position = vec4((u_matrix * vec3(a_position, 1.0)).xy, 0.0, 1.0);
}`,
  fs: `${header}
in vec2 v_world;
uniform vec4 u_color;
uniform int u_patterned;
uniform mat3 u_worldToUv;
uniform sampler2D u_tile;
out vec4 color;
void main() {
  if (u_patterned == 1) color = texture(u_tile, (u_worldToUv * vec3(v_world, 1.0)).xy);
  else color = u_color;
}`
};

// One instance per segment (x0 y0 x1 y1 startDistance). Quads are extended by half width at both ends so
// consecutive segments overlap at joins; translucent paths use a per-path stencil so overlap blends once.
export const stroke = {
  vs: `${header}
in vec2 a_corner;
in vec4 a_segment;
in float a_distance;
in vec2 a_caps;
uniform mat3 u_matrix;
uniform float u_halfWidth;
uniform float u_aaPad;
out float v_distance;
out vec2 v_local;
flat out vec3 v_segmentCaps;
void main() {
  vec2 p0 = a_segment.xy;
  vec2 p1 = a_segment.zw;
  float len = length(p1 - p0);
  vec2 dir = len > 0.0 ? (p1 - p0) / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  // u_aaPad (one device pixel, world units) widens the quad only for analytic-AA opaque strokes; 0 otherwise
  float reach = u_halfWidth + u_aaPad;
  float along = mix(-reach, len + reach, a_corner.x);
  vec2 world = p0 + dir * along + normal * reach * a_corner.y;
  v_distance = a_distance + along;
  v_local=vec2(along,reach*a_corner.y);
  v_segmentCaps=vec3(len,a_caps);
  gl_Position = vec4((u_matrix * vec3(world, 1.0)).xy, 0.0, 1.0);
}`,
  fs: `${header}
in float v_distance;
in vec2 v_local;
flat in vec3 v_segmentCaps;
uniform float u_halfWidth;
uniform vec4 u_color;
uniform float u_dashes[8];
uniform int u_dashCount;
uniform float u_dashPeriod;
uniform float u_dashOffset;
uniform float u_dashCap;
uniform float u_capReach;
uniform float u_aaPad;
uniform float u_pxPerWorld;
out vec4 color;
void main() {
  float outside= v_local.x<0.0 ? -v_local.x : max(0.0,v_local.x-v_segmentCaps.x);
  float cap= v_local.x<0.0 ? v_segmentCaps.y : v_segmentCaps.z;
  if(outside>0.0){
    if(cap==1.0)discard;
    if(cap==2.0 && outside*outside+v_local.y*v_local.y>u_halfWidth*u_halfWidth)discard;
  }
  if (u_dashCount > 0) {
    float p = mod(v_distance + u_dashOffset, u_dashPeriod);
    bool on = true;
    float run = u_dashPeriod;
    for (int i = 0; i < 8; i++) {
      if (i >= u_dashCount) break;
      run = u_dashes[i];
      if (p < run) break;
      p -= run;
      on = !on;
    }
    // SVG caps every dash (mirrored by dashCovered in geometry.ts): keep gap fragments inside the nearest end's cap
    if (!on) {
      float gap = min(p, run - p);
      if (u_dashCap == 1.0 || gap > u_capReach) discard;
      if (u_dashCap == 2.0 && gap * gap + v_local.y * v_local.y > u_capReach * u_capReach) discard;
    }
  }
  // Opaque strokes only (u_aaPad > 0): analytic edge coverage from the signed distance to the centreline, evaluated
  // at the pixel centre in device pixels. The widened quad guarantees the fringe pixels are rasterized.
  float cov = u_aaPad > 0.0 ? clamp((u_halfWidth - abs(v_local.y)) * u_pxPerWorld + 0.5, 0.0, 1.0) : 1.0;
  color = u_color * cov;
}`
};

// Relief icons: instance (x y size u0 v0 u1 v1), same contract as drawImage(sprite, x, y, s, s).
export const sprite = {
  vs: `${header}
in vec2 a_corner;
in vec3 a_place;
in vec4 a_uv;
uniform mat3 u_matrix;
out vec2 v_uv;
void main() {
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  vec2 world = a_place.xy + a_corner * a_place.z;
  gl_Position = vec4((u_matrix * vec3(world, 1.0)).xy, 0.0, 1.0);
}`,
  fs: `${header}
in vec2 v_uv;
uniform sampler2D u_texture;
out vec4 color;
void main() { color = texture(u_texture, v_uv); }`
};

// Trade markers: instance origin + u/v axes (the D3 group affine applied to the <use> box) over an RGBA symbol texture.
export const marker = {
  vs: `${header}
in vec2 a_corner;
in vec2 a_origin;
in vec4 a_axes;
uniform mat3 u_matrix;
out vec2 v_uv;
void main() {
  v_uv = a_corner;
  vec2 world = a_origin + a_corner.x * a_axes.xy + a_corner.y * a_axes.zw;
  gl_Position = vec4((u_matrix * vec3(world, 1.0)).xy, 0.0, 1.0);
}`,
  fs: sprite.fs
};

// Label glyphs: instance (cx cy angle) + (lx ly w h) + uv + rgba; the atlas stores coverage in alpha.
export const glyph = {
  vs: `${header}
in vec2 a_corner;
in vec3 a_anchor;
in vec4 a_box;
in vec4 a_uv;
in vec4 a_color;
uniform mat3 u_matrix;
out vec2 v_uv;
out vec4 v_color;
void main() {
  vec2 local = a_box.xy + a_corner * a_box.zw;
  float c = cos(a_anchor.z);
  float s = sin(a_anchor.z);
  vec2 world = a_anchor.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_color = vec4(a_color.rgb * a_color.a, a_color.a);
  gl_Position = vec4((u_matrix * vec3(world, 1.0)).xy, 0.0, 1.0);
}`,
  fs: `${header}
in vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_atlas;
out vec4 color;
void main() { color = v_color * texture(u_atlas, v_uv).a; }`
};

// Textured rectangle (compat runs in world or screen space, group composites) with an opacity multiplier.
export const image = {
  vs: `${header}
in vec2 a_corner;
uniform mat3 u_matrix;
uniform vec4 u_rect;
uniform vec4 u_uv;
out vec2 v_uv;
void main() {
  v_uv = mix(u_uv.xy, u_uv.zw, a_corner);
  gl_Position = vec4((u_matrix * vec3(u_rect.xy + a_corner * u_rect.zw, 1.0)).xy, 0.0, 1.0);
}`,
  fs: `${header}
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_opacity;
out vec4 color;
void main() { color = texture(u_texture, v_uv) * u_opacity; }`
};
