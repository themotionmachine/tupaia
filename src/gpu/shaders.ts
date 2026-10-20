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

// One instance per segment (x0 y0 x1 y1 startDistance) plus its two packed end codes (geometry.ts appendStrokeCaps).
// Coverage is analytic in device pixels (box filter, CPU mirrors in geometry.ts): the band profile across the stroke,
// butt and square ends filtered along it, round caps and round joins as discs, miter and bevel joins as the
// intersection of the two segments' extended bands (clipped at the bevel line past the miter limit 4), and dashes as
// the on-fraction of the pixel footprint along the path (round dash caps as discs around each dash end). A join is
// split between its two segments at the bisector through the vertex (normal dIn + dOut): each pixel centre takes its
// coverage from the one segment on its side, so neither the inner overlap of the two bodies nor the outer wedge is
// drawn twice, and an earlier segment's partial edge pixel never lands inside the next segment's body. Overlaps left
// (self-crossings, subpaths that cross or share segments, very short segments at sharp turns) blend for an opaque
// stroke without shared segments and are resolved by the stencil otherwise (framegraph.ts stroke), drawing in passes of decreasing
// u_minCoverage (a fragment below it is discarded).
export const stroke = {
  vs: `${header}
in vec2 a_corner;
in vec4 a_segment;
in float a_distance;
in vec2 a_caps;
uniform mat3 u_matrix;
uniform float u_halfWidth;
uniform float u_pad;
out float v_distance;
out vec2 v_local;
flat out vec3 v_segment;
flat out vec4 v_neighbours;
const float PI = 3.141592653589793;
vec2 neighbour(float packed, float code, vec2 dir, vec2 normal) {
  float angle = packed - code * 8.0 - PI;
  vec2 d = vec2(cos(angle), sin(angle));
  return vec2(dot(d, dir), dot(d, normal));
}
// how far past its end a segment's quad must reach: the miter tip of a miter join within the limit, else the half width
float reach(float code, float turnCos) {
  float c = sqrt(max(0.0, (1.0 + turnCos) * 0.5));
  return code == 4.0 && c >= 0.25 ? u_halfWidth / c : u_halfWidth;
}
void main() {
  vec2 p0 = a_segment.xy;
  vec2 p1 = a_segment.zw;
  float len = length(p1 - p0);
  vec2 dir = len > 0.0 ? (p1 - p0) / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float c0 = floor(a_caps.x / 8.0);
  float c1 = floor(a_caps.y / 8.0);
  vec2 before = neighbour(a_caps.x, c0, dir, normal);
  vec2 after = neighbour(a_caps.y, c1, dir, normal);
  // u_pad is one device pixel in world units: room for the anti-aliased fringe
  float along = mix(-reach(c0, before.x) - u_pad, len + reach(c1, after.x) + u_pad, a_corner.x);
  float across = (u_halfWidth + u_pad) * a_corner.y;
  v_distance = a_distance + along;
  v_local = vec2(along, across);
  v_segment = vec3(len, c0, c1);
  v_neighbours = vec4(before, after);
  gl_Position = vec4((u_matrix * vec3(p0 + dir * along + normal * across, 1.0)).xy, 0.0, 1.0);
}`,
  fs: `${header}
in float v_distance;
in vec2 v_local;
flat in vec3 v_segment;
flat in vec4 v_neighbours;
uniform float u_halfWidth;
uniform vec4 u_color;
uniform float u_dashes[8];
uniform int u_dashCount;
uniform float u_dashPeriod;
uniform float u_dashOn;
uniform float u_dashOffset;
uniform float u_dashCap;
uniform float u_pxPerWorld;
// geometry.ts discProfile: the area-preserving band radius and scale for discs of the stroke's half width (device px)
uniform float u_discRadius;
uniform float u_discScale;
uniform float u_minCoverage;
out vec4 color;
const float PI = 3.141592653589793;
const float BISECTOR_SLACK = 0.05;
float strip(float d, float h) { return clamp(min(d + 0.5, h) - max(d - 0.5, -h), 0.0, 1.0); }
float span(float x, float lo, float hi) { return clamp(min(x + 0.5, hi) - max(x - 0.5, lo), 0.0, 1.0); }
float disc(float r) { return strip(r, u_discRadius) * u_discScale; }
// q relative to the join vertex; dIn arrives at it, dOut leaves it (unit, segment-local)
float join(vec2 q, vec2 dIn, vec2 dOut, float code, float h) {
  if (code == 3.0) return disc(length(q));
  float cov = min(strip(abs(dIn.x * q.y - dIn.y * q.x), h), strip(abs(dOut.x * q.y - dOut.y * q.x), h));
  float c = sqrt(max(0.0, (1.0 + dot(dIn, dOut)) * 0.5));
  vec2 tip = dIn - dOut;
  float tipLength = length(tip);
  if ((code == 5.0 || c < 0.25) && tipLength > 1e-6) cov = min(cov, clamp(h * c - dot(q, tip / tipLength) + 0.5, 0.0, 1.0));
  return cov;
}
// signed distance of q from the line through the origin with normal n (positive on n's side); none for n = 0
float beyond(vec2 q, vec2 n) {
  return dot(n, n) > 1e-6 ? dot(q, normalize(n)) : 1e9;
}
float dashOnLength(float t) {
  float k = floor(t / u_dashPeriod);
  float r = t - k * u_dashPeriod;
  float acc = 0.0;
  float pos = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_dashCount) break;
    if ((i & 1) == 0) acc += clamp(r - pos, 0.0, u_dashes[i]);
    pos += u_dashes[i];
  }
  return k * u_dashOn + acc;
}
float dashGap(float t) {
  float r = mod(t, u_dashPeriod);
  float pos = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_dashCount) break;
    float run = u_dashes[i];
    if (r < pos + run || i == u_dashCount - 1) return (i & 1) == 0 ? 0.0 : max(0.0, min(r - pos, pos + run - r));
    pos += run;
  }
  return 0.0;
}
void main() {
  float px = u_pxPerWorld;
  float h = u_halfWidth * px;
  float x = v_local.x * px;
  float y = v_local.y * px;
  float len = v_segment.x * px;
  float c0 = v_segment.y;
  float c1 = v_segment.z;
  // The neighbouring segment's side of a join bisector is its pixel, body and wedge alike. Both segments keep centres
  // within BISECTOR_SLACK device px of it: they interpolate their local frames from different quads, and a centre on
  // the bisector must not be discarded by both. Both draw that sliver: a blended stroke (u_minCoverage < 0) draws
  // 1 - sqrt(1 - cov) there, which src-over of the two fragments composes back to cov (the two coverages agree on the
  // bisector by symmetry); a banded one keeps one fragment (stencil). A reversal (dIn = -dOut) has no bisector.
  float s0 = c0 >= 3.0 ? beyond(vec2(x, y), v_neighbours.xy + vec2(1.0, 0.0)) : 1e9;
  float s1 = c1 >= 3.0 ? beyond(vec2(len - x, -y), vec2(1.0, 0.0) + v_neighbours.zw) : 1e9;
  if (min(s0, s1) < -BISECTOR_SLACK) discard;
  bool shared = abs(s0) <= BISECTOR_SLACK || abs(s1) <= BISECTOR_SLACK;
  float cov;
  if (x < 0.0 && c0 >= 2.0) {
    vec2 q = vec2(x, y);
    cov = c0 == 2.0 ? disc(length(q)) : join(q, v_neighbours.xy, vec2(1.0, 0.0), c0, h);
  } else if (x > len && c1 >= 2.0) {
    vec2 q = vec2(x - len, y);
    cov = c1 == 2.0 ? disc(length(q)) : join(q, vec2(1.0, 0.0), v_neighbours.zw, c1, h);
  } else {
    float lo = c0 == 1.0 ? 0.0 : c0 == 0.0 ? -h : -1e9;
    float hi = c1 == 1.0 ? len : c1 == 0.0 ? len + h : 1e9;
    cov = strip(abs(y), h) * span(x, lo, hi);
  }
  // On the inner side of a join the neighbour's band, past the bisector, covers part of a pixel within half a pixel of
  // it (the inner corner pixel most): add its box-filtered share (band coverage within the bisector's half-plane) as a
  // union. On the outer side the neighbour's half of the wedge is the join itself, which cov already holds.
  if (c0 >= 3.0 && y * v_neighbours.y < 0.0) {
    vec2 dIn = v_neighbours.xy;
    vec2 n = dIn + vec2(1.0, 0.0);
    if (dot(n, n) > 1e-6) {
      float t = min(strip(abs(dIn.x * y - dIn.y * x), h), clamp(0.5 - dot(vec2(x, y), normalize(n)), 0.0, 1.0));
      cov = cov + t - cov * t;
    }
  }
  if (c1 >= 3.0 && y * v_neighbours.w > 0.0) {
    vec2 dOut = v_neighbours.zw;
    vec2 n = vec2(1.0, 0.0) + dOut;
    vec2 q = vec2(x - len, y);
    if (dot(n, n) > 1e-6) {
      float t = min(strip(abs(dOut.x * q.y - dOut.y * q.x), h), clamp(0.5 + dot(q, normalize(n)), 0.0, 1.0));
      cov = cov + t - cov * t;
    }
  }
  if (u_dashCount > 0) {
    float t = v_distance + u_dashOffset;
    float dash;
    if (u_dashCap == 2.0) {
      if (u_dashPeriod * px < 2.0) {
        // sub-pixel pattern: its mean coverage, each dash lengthened by the area of its two half-disc caps
        float capped = u_dashOn + float(u_dashCount / 2) * PI * 0.5 * u_halfWidth;
        dash = strip(abs(y), h) * clamp(capped / u_dashPeriod, 0.0, 1.0);
      } else {
        float g = dashGap(t) * px;
        dash = g <= 0.0 ? strip(abs(y), h) : disc(length(vec2(g, y)));
      }
    } else {
      // butt (square caps arrive pre-extended as butt dashes): on-fraction of the pixel footprint along the path
      float footprint = 0.5 / px;
      dash = strip(abs(y), h) * clamp((dashOnLength(t + footprint) - dashOnLength(t - footprint)) * px, 0.0, 1.0);
    }
    cov = min(cov, dash);
  }
  if (shared && u_minCoverage < 0.0) cov = 1.0 - sqrt(max(0.0, 1.0 - cov));
  if (cov <= 0.0 || cov < u_minCoverage) discard;
  color = u_color * cov;
}`
};

// Fill anti-aliasing fringe (framegraph.ts fill): one instance per boundary edge (x0 y0 x1 y1, filled side on the left,
// geometry.ts appendFillEdges). A pixel centre within half a device pixel of an edge gets the box-filtered half-plane
// coverage 0.5 + s (s the signed distance, positive on the filled side): u_inside selects the pass, 1 for pixel
// centres the stencil found inside the fill (they draw with coverage below 1 instead of the cover's full colour), 0
// for those outside it (coverage above 0 where SVG paints a partial edge pixel).
export const fringe = {
  vs: `${header}
in vec2 a_corner;
in vec4 a_edge;
uniform mat3 u_matrix;
uniform float u_pad;
out vec2 v_local;
out vec2 v_world;
flat out float v_length;
void main() {
  vec2 p0 = a_edge.xy;
  vec2 p1 = a_edge.zw;
  float len = length(p1 - p0);
  vec2 dir = len > 0.0 ? (p1 - p0) / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float along = mix(-u_pad, len + u_pad, a_corner.x);
  float across = u_pad * a_corner.y;
  v_local = vec2(along, across);
  v_length = len;
  v_world = p0 + dir * along + normal * across;
  gl_Position = vec4((u_matrix * vec3(v_world, 1.0)).xy, 0.0, 1.0);
}`,
  fs: `${header}
in vec2 v_local;
in vec2 v_world;
flat in float v_length;
uniform vec4 u_color;
uniform int u_patterned;
uniform mat3 u_worldToUv;
uniform sampler2D u_tile;
uniform int u_inside;
uniform float u_pxPerWorld;
out vec4 color;
void main() {
  float x = v_local.x * u_pxPerWorld;
  float s = v_local.y * u_pxPerWorld;
  if (x < -0.5 || x > v_length * u_pxPerWorld + 0.5) discard;
  if (u_inside == 1 ? s <= 0.0 : s >= 0.0) discard;
  float cov = clamp(0.5 + s, 0.0, 1.0);
  if (cov <= 0.0 || cov >= 1.0) discard;
  vec4 base = u_patterned == 1 ? texture(u_tile, (u_worldToUv * vec3(v_world, 1.0)).xy) : u_color;
  color = base * cov;
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
