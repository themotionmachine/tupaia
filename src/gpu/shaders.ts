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

// Coverage models (framegraph.ts COVERAGE_SAMPLES). Chrome rasterises an SVG path with 4x MSAA at the standard sample
// positions (coverage in quarters: polylines, curves, polygons, dashed and translucent strokes, on Metal at dpr 1 and
// 2), and only a lone straight line, a rect and a circle or ellipse with analytic coverage
// (~/.tupaia-gates/w3-stroke2/exp: 284/287 edge pixels of a concave fill match the 4-sample model exactly, 51/287 the
// box filter). Native strokes and fill edges follow suit: u_samples 4 counts the samples (u_sampleOffsets, window
// px from the pixel centre, GL y up) inside the exact shape, u_samples 0 is the analytic box filter, for the batches
// SVG draws analytically (geometry.ts analyticShape), and u_samples 1 tests the pixel centre alone, for the shapes SVG
// draws without anti-aliasing (geometry.ts aliasedShape: a rect under shape-rendering optimizeSpeed). A box filter
// instead of the samples adds faint fringe pixels SVG never paints and spreads the rest over the quarter steps: the
// D11 coverage gate read that as 13-48 % extra ink. Thin hairline strokes need no program change: framegraph.ts
// draws them 1 device px wide at a fraction of their colour (geometry.ts thinHairline).
const coverageUniforms = `uniform int u_samples;
uniform vec2 u_sampleOffsets[4];
vec2 sampleOffset(int i) { return u_samples == 1 ? vec2(0.0) : u_sampleOffsets[i]; }`;

// One instance per segment (x0 y0 x1 y1 startDistance) plus its two packed end codes (geometry.ts appendStrokeCaps).
// A join is split between its two segments at the bisector through the vertex (normal dIn + dOut): each pixel centre
// is drawn by the one segment on its side, so a pixel is never blended twice by the two segments of a join.
// Samples (u_samples 4): the owning segment tests each sample against the exact local outline (strokeCovers): its own
// body, its caps, and at each join the join shape (round: Skia's chord fan, fanHas; miter: the intersection of the two
// segments' bands, clipped at the bevel line past the miter limit 4 or for a bevel join) plus the neighbour's body as
// a band from the vertex, so samples past the bisector count exactly as MSAA counts them. Round caps are chord fans
// too. Dashes are tested per sample at the sample's own distance along the path (round dash caps as fans around each
// dash end).
// Analytic (u_samples 0, a lone line in SVG): the box-filtered band profile across the stroke, butt and square ends
// filtered along it, round caps and joins as discs, miter and bevel joins as the band intersection, dashes as the
// on-fraction of the pixel footprint along the path; on the inner side of a join the neighbour's share is added as a
// union. Overlaps left (self-crossings, subpaths that cross or share segments, very short segments at sharp turns)
// blend for an opaque stroke without shared segments and are resolved by the stencil otherwise (framegraph.ts stroke),
// drawing in passes of decreasing u_minCoverage (a fragment below it is discarded).
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
uniform float u_radialPerRadian;
${coverageUniforms}
out vec4 color;
const float PI = 3.141592653589793;
const float BISECTOR_SLACK = 0.05;
float strip(float d, float h) { return clamp(min(d + 0.5, h) - max(d - 0.5, -h), 0.0, 1.0); }
float span(float x, float lo, float hi) { return clamp(min(x + 0.5, hi) - max(x - 0.5, lo), 0.0, 1.0); }
float disc(float r) { return strip(r, u_discRadius) * u_discScale; }
float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
// q relative to the join vertex; dIn arrives at it, dOut leaves it (unit, segment-local)
float join(vec2 q, vec2 dIn, vec2 dOut, float code, float h) {
  if (code == 3.0) return disc(length(q));
  float cov = min(strip(abs(cross2(dIn, q)), h), strip(abs(cross2(dOut, q)), h));
  float c = sqrt(max(0.0, (1.0 + dot(dIn, dOut)) * 0.5));
  vec2 tip = dIn - dOut;
  float tipLength = length(tip);
  if ((code == 5.0 || c < 0.25) && tipLength > 1e-6) cov = min(cov, clamp(h * c - dot(q, tip / tipLength) + 0.5, 0.0, 1.0));
  return cov;
}
// Skia's round: a fan of chords around the centre, whose vertices lie on the circle of radius h and divide span
// radians (from direction a, turning toward b) into ceil(span * u_radialPerRadian) equal sectors (its stroke
// tessellator: 0.5 / acos(1 - 0.25 / h) radial segments per radian, ~/.tupaia-gates/w3-stroke2/exp/dots.mjs: a dot of
// h 0.5 device px is a diamond, 2 samples where a disc covers 3). Whether q (relative to the centre, inside the
// sector) lies in it.
bool fanHas(vec2 q, vec2 a, vec2 b, float span, float h) {
  float n = max(1.0, ceil(span * u_radialPerRadian - 1e-4));
  float turn = cross2(a, b) < 0.0 ? -1.0 : 1.0;
  float phi = atan(turn * cross2(a, q), dot(a, q));
  float sector = span / n;
  float mid = (clamp(floor(phi / sector), 0.0, n - 1.0) + 0.5) * sector;
  vec2 m = a * cos(mid) + vec2(-a.y, a.x) * (turn * sin(mid));
  return dot(q, m) <= h * cos(sector * 0.5);
}
// a round cap facing +x at the origin (q.x >= 0): the half fan from +y to -y
bool capHas(vec2 q, float h) {
  return q.x >= 0.0 && fanHas(q, vec2(0.0, 1.0), vec2(1.0, 0.0), PI, h);
}
// point form of join(): whether q (relative to the vertex) lies in the join shape. Every join is cut to the outer
// wedge, past the vertex along dIn and before it along dOut (the intersection of two nearly parallel bands would run
// far along the path, past the ends of short segments). Round: the fan from the outer normal of dIn to that of dOut,
// and the disc outside the wedge, past the end of a segment shorter than the width that the bands miss; miter and
// bevel: the band intersection.
bool joinHas(vec2 q, vec2 dIn, vec2 dOut, float code, float h) {
  if (dot(q, dIn) < 0.0 || dot(q, dOut) > 0.0) return code == 3.0 && dot(q, q) <= h * h;
  if (code == 3.0) {
    float side = cross2(dIn, dOut) > 0.0 ? -1.0 : 1.0; // the outer side: right of a left turn
    vec2 nIn = side * vec2(-dIn.y, dIn.x);
    vec2 nOut = side * vec2(-dOut.y, dOut.x);
    return fanHas(q, nIn, nOut, acos(clamp(dot(dIn, dOut), -1.0, 1.0)), h);
  }
  if (abs(cross2(dIn, q)) > h || abs(cross2(dOut, q)) > h) return false;
  float c = sqrt(max(0.0, (1.0 + dot(dIn, dOut)) * 0.5));
  vec2 tip = dIn - dOut;
  float tipLength = length(tip);
  return !((code == 5.0 || c < 0.25) && tipLength > 1e-6) || dot(q, tip / tipLength) <= h * c;
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
// A dot pattern (round caps, every on-dash of zero length: province borders "0 2"): Skia strokes a zero-length segment
// at a fixed orientation, as if it ran along the screen's x axis, so each dot is the round fan with vertices straight
// up and down on screen, whatever the path's direction (~/.tupaia-gates/w3b-stroke3/exp/dotfit.mjs: 97.8-99.7 % of the
// pixels of dots of 0.5-2.5 px radius, along eight directions, against 93.5-97 % for the fan turned with the path).
// The sample at q (path distance t) is tested against the nearest dot, in screen axes (ex, ey: window x and y in the
// segment's frame). No dot lies before an open start or past an open end.
bool dotCovers(vec2 q, float t, float len, float c0, float c1, float h, float px, vec2 ex, vec2 ey) {
  float r = mod(t, u_dashPeriod);
  float best = 1e9;
  float pos = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_dashCount) break;
    if ((i & 1) == 0) {
      float d = r - pos; // world, the sample's along offset from this dot
      if (abs(d - u_dashPeriod) < abs(d)) d -= u_dashPeriod;
      if (abs(d + u_dashPeriod) < abs(d)) d += u_dashPeriod;
      if (abs(d) < abs(best)) best = d;
    }
    pos += u_dashes[i];
  }
  vec2 rel = vec2(best * px, q.y);
  float centre = q.x - rel.x;
  if ((c0 <= 2.0 && centre < -0.01) || (c1 <= 2.0 && centre > len + 0.01)) return false;
  vec2 screen = vec2(dot(rel, ex), dot(rel, ey));
  return capHas(screen.x >= 0.0 ? screen : -screen, h);
}
// Whether the sample at q (segment-local device px) and path distance t (world) lies in the stroke (geometry.ts
// strokeCovers mirrors it).
bool strokeCovers(vec2 q, float t, float len, float c0, float c1, float h, float px) {
  bool inside = abs(q.y) <= h && q.x >= (c0 == 0.0 ? -h : 0.0) && q.x <= (c1 == 0.0 ? len + h : len);
  if (!inside && c0 == 2.0) inside = capHas(vec2(-q.x, -q.y), h);
  if (!inside && c0 >= 3.0) {
    vec2 d = v_neighbours.xy;
    inside = (dot(q, d) <= 0.0 && abs(cross2(d, q)) <= h) || joinHas(q, d, vec2(1.0, 0.0), c0, h);
  }
  vec2 e = q - vec2(len, 0.0);
  if (!inside && c1 == 2.0) inside = capHas(e, h);
  if (!inside && c1 >= 3.0) {
    vec2 d = v_neighbours.zw;
    inside = (dot(e, d) >= 0.0 && abs(cross2(d, e)) <= h) || joinHas(e, vec2(1.0, 0.0), d, c1, h);
  }
  if (!inside || u_dashCount == 0) return inside;
  // butt (square caps arrive pre-extended as butt dashes): inside a dash; round: or within the cap disc of a dash end
  float g = dashGap(t) * px;
  return g <= 0.0 || (u_dashCap == 2.0 && capHas(vec2(g, q.y), h));
}
void main() {
  float px = u_pxPerWorld;
  // window-pixel steps of the segment-local position (device px), taken before any discard
  vec2 stepX = dFdx(v_local) * px;
  vec2 stepY = dFdy(v_local) * px;
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
  if (u_samples > 0) {
    float t = v_distance + u_dashOffset;
    bool dots = u_dashCount > 0 && u_dashCap == 2.0 && u_dashOn <= 0.0;
    vec2 ex = normalize(stepX);
    vec2 ey = normalize(stepY);
    int n = 0;
    for (int i = 0; i < 4; i++) {
      if (i >= u_samples) break;
      vec2 o = sampleOffset(i);
      vec2 dq = stepX * o.x + stepY * o.y;
      vec2 sq = vec2(x, y) + dq;
      float st = t + dq.x / px;
      if (dots ? dotCovers(sq, st, len, c0, c1, h, px, ex, ey) : strokeCovers(sq, st, len, c0, c1, h, px)) n++;
    }
    cov = float(n) / float(u_samples);
  } else {
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
    // On the inner side of a join the neighbour's band, past the bisector, covers part of a pixel within half a pixel
    // of it (the inner corner pixel most): add its box-filtered share (band coverage within the bisector's half-plane)
    // as a union. On the outer side the neighbour's half of the wedge is the join itself, which cov already holds.
    if (c0 >= 3.0 && y * v_neighbours.y < 0.0) {
      vec2 dIn = v_neighbours.xy;
      vec2 n = dIn + vec2(1.0, 0.0);
      if (dot(n, n) > 1e-6) {
        float t = min(strip(abs(cross2(dIn, vec2(x, y))), h), clamp(0.5 - dot(vec2(x, y), normalize(n)), 0.0, 1.0));
        cov = cov + t - cov * t;
      }
    }
    if (c1 >= 3.0 && y * v_neighbours.w > 0.0) {
      vec2 dOut = v_neighbours.zw;
      vec2 n = vec2(1.0, 0.0) + dOut;
      vec2 q = vec2(x - len, y);
      if (dot(n, n) > 1e-6) {
        float t = min(strip(abs(cross2(dOut, q)), h), clamp(0.5 + dot(q, normalize(n)), 0.0, 1.0));
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
        // butt: on-fraction of the pixel footprint along the path
        float footprint = 0.5 / px;
        dash = strip(abs(y), h) * clamp((dashOnLength(t + footprint) - dashOnLength(t - footprint)) * px, 0.0, 1.0);
      }
      cov = min(cov, dash);
    }
  }
  if (shared && u_minCoverage < 0.0) cov = 1.0 - sqrt(max(0.0, 1.0 - cov));
  if (cov <= 0.0 || cov < u_minCoverage) discard;
  color = u_color * cov;
}`
};

// Fill anti-aliasing fringe (framegraph.ts fill): one instance per boundary edge, read from the ring point stream
// (geometry.ts appendFillEdges: per ring, filled side on the left, its points with one before and two after wrapped,
// then a sentinel): a_prev, a_edge (x0 y0 x1 y1) and a_next are four consecutive points, and an instance holding the
// sentinel straddles two rings and draws nothing. A pixel centre within half a device pixel of the edge is drawn:
// u_inside selects the pass, 1 for pixel centres the stencil found inside the fill (they draw with coverage below 1
// instead of the cover's full colour), 0 for those outside it (coverage above 0 where SVG paints a partial edge pixel).
// Samples (u_samples 4): each sample is inside the edge's half-plane, cut by the previous edge's at a convex start
// vertex or joined with it at a reflex one, and the same with the next edge at the end: the exact outline wherever
// the pixel sees only these three edges (a feature thinner than a pixel, two non-adjacent edges, stays approximate).
// Analytic (u_samples 0, a rect, circle or ellipse in SVG): the box-filtered half-plane coverage 0.5 + s (s the
// signed distance, positive on the filled side).
export const FRINGE_SENTINEL = 3.0e38;
export const fringe = {
  vs: `${header}
in vec2 a_corner;
in vec2 a_prev;
in vec4 a_edge;
in vec2 a_next;
uniform mat3 u_matrix;
uniform float u_pad;
out vec2 v_local;
out vec2 v_world;
flat out float v_length;
// the neighbouring edges' directions in this edge's frame (prev arriving at p0, next leaving p1), and whether each
// vertex is convex (1) or reflex (0) for the filled (left) side
flat out vec4 v_neighbours;
flat out vec2 v_convex;
// the neighbouring edges' lengths (world): their half-planes hold only beside them
flat out vec2 v_neighbourLengths;
void main() {
  vec2 p0 = a_edge.xy;
  vec2 p1 = a_edge.zw;
  if (max(max(abs(a_prev.x), abs(a_next.x)), max(abs(p0.x), abs(p1.x))) > 1.0e38) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // straddles two rings: outside the clip volume
    return;
  }
  float len = length(p1 - p0);
  vec2 dir = len > 0.0 ? (p1 - p0) / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec2 before = p0 - a_prev;
  vec2 after = a_next - p1;
  v_neighbourLengths = vec2(length(before), length(after));
  before = dot(before, before) > 0.0 ? normalize(before) : dir;
  after = dot(after, after) > 0.0 ? normalize(after) : dir;
  v_neighbours = vec4(dot(before, dir), dot(before, normal), dot(after, dir), dot(after, normal));
  // a left turn keeps the filled side inside the corner: convex
  v_convex = vec2(before.x * dir.y - before.y * dir.x >= 0.0 ? 1.0 : 0.0, dir.x * after.y - dir.y * after.x >= 0.0 ? 1.0 : 0.0);
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
flat in vec4 v_neighbours;
flat in vec2 v_convex;
flat in vec2 v_neighbourLengths;
uniform vec4 u_color;
uniform int u_patterned;
uniform mat3 u_worldToUv;
uniform sampler2D u_tile;
uniform int u_inside;
uniform float u_pxPerWorld;
${coverageUniforms}
out vec4 color;
// whether q (edge-local device px: along, signed distance to the filled side) is inside the fill near this edge.
// A neighbour's half-plane counts only beside that neighbour (q projects onto it, within half a pixel): past its far
// end the line through it is no boundary, and a short neighbour nearly reversing this edge (a spike, an acute tip)
// would otherwise cut samples all along this edge (an unpainted sliver inside the fill). px: device px per world unit.
bool fillCovers(vec2 q, float len, float px) {
  bool inside = q.y > 0.0;
  // previous edge's half-plane through p0: its left normal is (-d.y, d.x) for its direction d
  vec2 d = v_neighbours.xy;
  float back = -dot(q, d); // distance back along the previous edge from p0
  if (back >= -0.5 && back <= v_neighbourLengths.x * px + 0.5) {
    bool prev = d.x * q.y - d.y * q.x > 0.0;
    inside = v_convex.x > 0.5 ? inside && prev : inside || prev;
  }
  vec2 e = q - vec2(len, 0.0);
  d = v_neighbours.zw;
  float ahead = dot(e, d); // distance along the next edge from p1
  if (ahead < -0.5 || ahead > v_neighbourLengths.y * px + 0.5) return inside;
  bool next = d.x * e.y - d.y * e.x > 0.0;
  return v_convex.y > 0.5 ? inside && next : inside || next;
}
// The analytic box filter at a corner (a rect's, say): the product of this edge's coverage and that of a neighbour
// turning 45 degrees or more at a convex vertex, the box filter's area for perpendicular edges. Chrome's analytic rect
// takes that product; the edge's coverage alone was up to 0.44 off at a corner pixel. Gentler turns (a circle's chords)
// keep the edge's own coverage. q and the bounds as in fillCovers.
float cornerCoverage(vec2 q, float len, float px) {
  float f = 1.0;
  vec2 d = v_neighbours.xy;
  float back = -dot(q, d);
  if (v_convex.x > 0.5 && d.x <= 0.7072 && back >= -0.5 && back <= v_neighbourLengths.x * px + 0.5)
    f *= clamp(0.5 + d.x * q.y - d.y * q.x, 0.0, 1.0);
  vec2 e = q - vec2(len, 0.0);
  d = v_neighbours.zw;
  float ahead = dot(e, d);
  if (v_convex.y > 0.5 && d.x <= 0.7072 && ahead >= -0.5 && ahead <= v_neighbourLengths.y * px + 0.5)
    f *= clamp(0.5 + d.x * e.y - d.y * e.x, 0.0, 1.0);
  return f;
}
void main() {
  float px = u_pxPerWorld;
  vec2 stepX = dFdx(v_local) * px;
  vec2 stepY = dFdy(v_local) * px;
  float x = v_local.x * px;
  float s = v_local.y * px;
  float len = v_length * px;
  if (x < -0.5 || x > len + 0.5) discard;
  if (u_inside == 1 ? s <= 0.0 : s >= 0.0) discard;
  float cov;
  if (u_samples > 0) {
    int n = 0;
    for (int i = 0; i < 4; i++) {
      if (i >= u_samples) break;
      vec2 o = sampleOffset(i);
      if (fillCovers(vec2(x, s) + stepX * o.x + stepY * o.y, len, px)) n++;
    }
    cov = float(n) / float(u_samples);
  } else cov = clamp(0.5 + s, 0.0, 1.0) * cornerCoverage(vec2(x, s), len, px);
  // an inside centre whose samples all miss still marks the pixel (drawn at 0), so the cover does not fill it
  if (u_inside == 1 ? cov >= 1.0 : cov <= 0.0) discard;
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

// Label glyphs: instance (cx cy angle) + (lx ly w h) + uv + rgba; the atlas stores coverage in alpha. A negative
// alpha marks a soft cell (a text-shadow's blurred mask, text.ts): drawn with |alpha| and no coverage floor.
//
// GLYPH (W3; this program only, the rest of the file is STROKE's): the coverage is reconstructed with a Lanczos-3
// filter, not bilinear. A curved label's glyph is an axis-aligned mask cut at the raster bucket and drawn rotated, at a
// sub-texel offset, where Skia rasterizes the SVG glyph directly at its rotation and position. Bilinear sampling
// smears every edge over about one more device px (a faint fringe: on the parity labels the GPU arm had ~20% more ink
// pixels than the SVG); Lanczos-3 keeps the edge as sharp as the mask (exact at texel centres), and the 3% coverage
// floor drops the faint ringing and fringe it leaves where Skia's own coverage is already zero. Where the bucket
// oversamples the screen by more than 10% (zoom between powers of two), the mask is box-filtered over the pixel
// footprint instead (four bilinear taps), which a fixed-size kernel would alias.
//
// GLYPH2 (W3b): two things Chromium does per zoom, which a glyph baked at the raster bucket cannot follow, are done
// here per frame from u_k, the camera's CSS px per world unit (one uniform, set by the text pass):
// - a central baseline (a_baseline = ascent, descent, mode; text.ts centralShiftAt is the reference copy): Chromium
//   rounds the ascent and descent of the font scaled by k to whole CSS px, so the shift moves with k inside a bucket
//   (up to 3.5 device px when baked at the prepare's zoom); mode 2 rounds a nested box's shift up to a whole CSS px;
// - a text-shadow, which Chromium paints in CSS px whatever the user-space transform. A soft cell anchors its
//   top-left corner at the text's pen, holds its Gaussian sigma in device px in the angle slot (soft cells are never
//   rotated) and its offset in CSS px in (lx, ly). Its mask was blurred at the raster bucket, i.e. with sigma
//   min(sigma, SHADOW_MASK_SIGMA) texels (text.ts cuts wider blurs at a reduced resolution), which on screen is
//   sigma * (k * dpr / bucket) device px: narrower than CSS's whenever k * dpr is not the bucket. The fragment shader
//   adds the missing Gaussian, sqrt(sigma^2 - shown^2) device px, as a weighted grid of bilinear taps clamped to the
//   cell (text.ts gives the cell a 6-sigma margin, enough for the bucket's 2x).
export const SHADOW_MASK_SIGMA = 2;
// text.ts GLYPH_ATLAS (the atlas edge its uvs are normalized by), repeated here because text.ts imports this file
export const GLYPH_ATLAS_EDGE = 2048;
export const glyph = {
  vs: `${header}
in vec2 a_corner;
in vec3 a_anchor;
in vec4 a_box;
in vec4 a_uv;
in vec4 a_color;
in vec3 a_baseline;
uniform mat3 u_matrix;
uniform float u_atlasScale; // GLYPH_ATLAS / the uploaded atlas rows (text.ts glyphAtlasRows)
uniform float u_k; // CSS px per world unit at the current camera
uniform float u_rows; // device rows of the render target (the drawing buffer)
out vec2 v_uv;
out vec4 v_color;
out float v_soft;
flat out float v_sigma;
flat out vec4 v_cell;
float centralShift() {
  if (a_baseline.z < 0.5) return 0.0;
  float css = (floor(a_baseline.x * u_k + 0.5) - floor(a_baseline.y * u_k + 0.5)) * 0.5;
  if (a_baseline.z > 1.5) css = ceil(css - 1e-3);
  return css / u_k;
}
// W3c: the world y offset that puts an unrotated glyph cell's top on a whole device row, when the cell is drawn at
// its atlas resolution (one texel per device px). Skia draws axis-aligned text with the baseline rounded to a whole
// device row (subpixel positioning in x only); the atlas cuts every cell with its baseline on a whole texel row, so
// at that resolution a top on a whole row is the baseline on one, and the Lanczos taps land on texel centres
// vertically. Elsewhere (rotated, soft, resampled cells) 0. text.ts glyphRowSnap is the reference copy.
float rowSnap(vec2 top) {
  if (abs(a_anchor.z) > 1e-4 || u_rows <= 0.0) return 0.0;
  float perWorld = u_matrix[1][1] * 0.5 * u_rows; // device rows per world unit (signed: the clip y axis)
  float texels = (a_uv.w - a_uv.y) * ${GLYPH_ATLAS_EDGE.toFixed(1)};
  if (abs(perWorld) < 1e-6 || abs(abs(perWorld) * a_box.w - texels) > 1e-3 * texels) return 0.0;
  float rows = ((u_matrix * vec3(top, 1.0)).y + 1.0) * 0.5 * u_rows;
  return (floor(rows + 0.5) - rows) / perWorld;
}
void main() {
  vec2 world;
  float shift = centralShift();
  v_soft = a_color.a < 0.0 ? 1.0 : 0.0;
  if (v_soft > 0.5) {
    world = a_anchor.xy + a_corner * a_box.zw + (a_box.xy + vec2(0.0, shift * u_k)) / max(u_k, 1e-6);
    v_sigma = a_anchor.z;
  } else {
    vec2 local = a_box.xy + a_corner * a_box.zw + vec2(0.0, shift);
    float c = cos(a_anchor.z);
    float s = sin(a_anchor.z);
    world = a_anchor.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
    world.y += rowSnap(a_anchor.xy + a_box.xy + vec2(0.0, shift));
    v_sigma = 0.0;
  }
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner) * vec2(1.0, u_atlasScale);
  v_cell = a_uv * vec4(1.0, u_atlasScale, 1.0, u_atlasScale);
  float alpha = abs(a_color.a);
  v_color = vec4(a_color.rgb * alpha, alpha);
  gl_Position = vec4((u_matrix * vec3(world, 1.0)).xy, 0.0, 1.0);
}`,
  fs: `${header}
in vec2 v_uv;
in vec4 v_color;
in float v_soft;
flat in float v_sigma;
flat in vec4 v_cell;
uniform sampler2D u_atlas;
out vec4 color;
float lanczos3(float x) {
  x = abs(x);
  if (x < 1e-4) return 1.0;
  if (x >= 3.0) return 0.0;
  float p = 3.14159265 * x;
  return 3.0 * sin(p) * sin(p / 3.0) / (p * p);
}
// the soft cell's coverage plus the Gaussian the bucket's mask lacks on screen (see the program's comment)
float softCoverage(vec2 p, vec2 dx, vec2 dy, vec2 size) {
  vec2 texel = 1.0 / size;
  vec2 lo = v_cell.xy + 0.5 * texel;
  vec2 hi = v_cell.zw - 0.5 * texel;
  float perPx = max(length(dx), length(dy)); // atlas texels per device px
  float shown = min(v_sigma, ${SHADOW_MASK_SIGMA.toFixed(1)}) / max(perPx, 1e-6); // the mask's sigma on screen, device px
  float extra = sqrt(max(v_sigma * v_sigma - shown * shown, 0.0)) * perPx; // texels
  if (extra < 0.35) return textureLod(u_atlas, clamp((p + 0.5) * texel, lo, hi), 0.0).a;
  float spacing = max(1.0, 0.75 * extra);
  int reach = int(min(4.0, ceil(3.0 * extra / spacing)));
  float k = -0.5 * spacing * spacing / (extra * extra);
  float sum = 0.0;
  float weights = 0.0;
  for (int j = -4; j <= 4; j++) {
    if (j < -reach || j > reach) continue;
    for (int i = -4; i <= 4; i++) {
      if (i < -reach || i > reach) continue;
      float w = exp(k * float(i * i + j * j));
      sum += w * textureLod(u_atlas, clamp((p + 0.5 + vec2(i, j) * spacing) * texel, lo, hi), 0.0).a;
      weights += w;
    }
  }
  return sum / weights;
}
void main() {
  ivec2 isize = textureSize(u_atlas, 0);
  vec2 size = vec2(isize);
  vec2 p = v_uv * size - 0.5;
  vec2 dx = dFdx(p);
  vec2 dy = dFdy(p);
  float coverage = 0.0;
  if (v_soft > 0.5) {
    coverage = softCoverage(p, dx, dy, size);
  } else {
    float minify = max(length(dx), length(dy)); // atlas texels per device px
    if (minify > 1.1) {
      vec2 texel = 1.0 / size;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2(i == 1 || i == 3 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
        // explicit level 0: the atlas has no mipmaps, and derivatives inside non-uniform control flow are undefined
        coverage += textureLod(u_atlas, (p + 0.5 + o.x * dx + o.y * dy) * texel, 0.0).a;
      }
      coverage *= 0.25;
    } else {
      vec2 f = fract(p);
      ivec2 base = ivec2(floor(p)) - 2;
      float wx[6];
      float wy[6];
      float sx = 0.0;
      float sy = 0.0;
      for (int i = 0; i < 6; i++) {
        wx[i] = lanczos3(f.x - float(i - 2));
        wy[i] = lanczos3(f.y - float(i - 2));
        sx += wx[i];
        sy += wy[i];
      }
      for (int j = 0; j < 6; j++) {
        float row = 0.0;
        for (int i = 0; i < 6; i++) row += wx[i] * texelFetch(u_atlas, clamp(base + ivec2(i, j), ivec2(0), isize - 1), 0).a;
        coverage += wy[j] * row;
      }
      coverage /= sx * sy;
    }
    coverage = clamp(coverage, 0.0, 1.0);
    if (coverage < 0.03) coverage = 0.0;
  }
  color = v_color * clamp(coverage, 0.0, 1.0);
}`
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
uniform sampler2D u_mask;
uniform bool u_masked;
uniform float u_opacity;
out vec4 color;
// u_masked: a group composite times its mask coverage (framegraph.ts maskCoverage; red = luminance)
void main() { color = texture(u_texture, v_uv) * u_opacity * (u_masked ? texture(u_mask, v_uv).r : 1.0); }`
};
