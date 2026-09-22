const FLIGHT_STAGGER = 380;
const FLIGHT_MIN = 760;
const FLIGHT_VARIATION = 280;
export const FLIGHT_GLOW = 200;
export const FORMATION_DURATION = FLIGHT_STAGGER + FLIGHT_MIN + FLIGHT_VARIATION + FLIGHT_GLOW;

// 按现有徽记的几何结构分组；同组内仍按目标点所在的轮廓、主体或装饰安排路径。
const profiles = {
  rhodes: 'triangle', babel: 'triangle', egir: 'triangle',
  yan: 'branches', sami: 'branches', siracusa: 'branches',
  bolivar: 'spokes', columbia: 'spokes',
  iberia: 'wings', laterano: 'wings', ursus: 'wings',
  leithanien: 'paired', sargon: 'paired', victoria: 'paired',
  higashi: 'orbit', kjerag: 'orbit', minos: 'orbit',
  kazimierz: 'slashes', rim: 'slashes', followers: 'staff',
  collaboration: 'lattice', rainbow: 'lattice',
};

export function planEmblemFlight(field, id, random) {
  const { count, targets, origins, flightControl1, flightControl2, arrivalDelays, flightDurations } = field;
  const profile = profiles[id] || 'sweep';
  // 图谱直达时画布隐藏，仍须得到有限坐标；显示页面时会重新按实际尺寸入场。
  const halfWidth = field.scale ? field.width / (2 * field.scale) : 1.2;
  const halfHeight = field.scale ? field.height / (2 * field.scale) : 1.2;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (let i = 0; i < count; i++) {
    const j = i * 3;
    left = Math.min(left, targets[j]); right = Math.max(right, targets[j]);
    top = Math.min(top, targets[j + 1]); bottom = Math.max(bottom, targets[j + 1]);
  }
  const width = Math.max(.001, right - left), height = Math.max(.001, bottom - top);
  for (let i = 0; i < count; i++) {
    const j = i * 3, x = targets[j], y = targets[j + 1];
    const u = (x - left) / width - .5, v = (y - top) / height;
    const side = u < 0 ? -1 : 1, reach = Math.abs(u);
    // source 指向屏幕外，bow 控制中段绕行，approach 控制落点前的切线。
    let sourceX = -1, sourceY = .15, bowX = 0, bowY = 0;
    let approachX = -.2, approachY = 0, order = u + .5;
    switch (profile) {
      case 'triangle': {
        const frameBottom = id === 'egir' ? .66 : 1;
        const edge = v < frameBottom && reach > v / frameBottom * .5 - .055;
        if (edge) {
          sourceX = side * .55; sourceY = 1;
          approachX = side * .13; approachY = .24;
          order = (1 - v / frameBottom) * .72;
        } else if (v > frameBottom - .09 && reach > .16) {
          sourceX = side; sourceY = 0;
          approachX = side * .22; approachY = 0;
          order = (.5 - reach) * .6;
        } else {
          sourceX = id === 'egir' && reach > .12 ? side : 0;
          sourceY = sourceX ? 0 : 1;
          approachX = sourceX * .18; approachY = sourceY * .22;
          order = .24 + (1 - v) * .76;
        }
        break;
      }
      case 'branches':
        sourceX = side * (.3 + reach); sourceY = -1;
        bowX = side * (.22 + reach * .4); bowY = -.12;
        approachX = side * (.06 + reach * .28); approachY = -.14;
        order = v * .75 + (.5 - reach) * .25;
        // 下方底座／花环从两端托入，与上方角枝分开。
        if (v > .8) {
          sourceX = side; sourceY = .5; bowY = .23;
          approachX = side * .16; approachY = .06; order = .7 + reach * .4;
        }
        break;
      case 'spokes': {
        const spokes = id === 'bolivar' ? 8 : 16;
        const angle = Math.round(Math.atan2(v - .5, u) / (Math.PI * 2) * spokes) / spokes * Math.PI * 2;
        sourceX = Math.cos(angle); sourceY = Math.sin(angle);
        approachX = sourceX * .22; approachY = sourceY * .22;
        order = Math.max(0, 1 - Math.hypot(u, v - .5) * 2);
        break;
      }
      case 'wings':
        if (reach > .1 && v < .76) {
          sourceX = side; sourceY = -.2;
          bowX = side * .1; bowY = -.65;
          approachX = side * .16; approachY = .12 - v * .16;
          order = (.5 - reach) * 1.3 + v * .25;
        } else {
          sourceX = 0; sourceY = -1;
          approachX = 0; approachY = -.24; order = v * .8;
        }
        break;
      case 'paired':
        sourceX = side; sourceY = .45;
        bowX = side * .18; bowY = .55;
        approachX = -side * .15; approachY = .16;
        order = (1 - v) * .55 + (.5 - reach) * .7;
        if (id === 'victoria' && reach < .2) {
          sourceX = 0; sourceY = -1; bowX = 0; bowY = 0;
          approachX = 0; approachY = -.2; order = v * .5;
        }
        break;
      case 'orbit': {
        const centerY = id === 'higashi' ? .31 : id === 'minos' ? .38 : .5;
        const radius = Math.hypot(u, v - centerY);
        const rim = radius > (id === 'higashi' ? .28 : .32) && (id !== 'higashi' || v < .65);
        if (rim) {
          const angle = Math.atan2(v - centerY, u);
          const nx = Math.cos(angle), ny = Math.sin(angle);
          sourceX = ny + nx * .35; sourceY = -nx + ny * .35;
          bowX = nx * .48; bowY = ny * .48;
          approachX = ny * .3; approachY = -nx * .3;
          order = (angle + Math.PI) / (Math.PI * 2) * .7;
        } else {
          sourceX = id === 'kjerag' ? -1 : 0; sourceY = sourceX ? .35 : 1;
          approachX = sourceX * .22; approachY = sourceY * .22;
          order = .25 + (1 - v) * .7;
        }
        break;
      }
      case 'slashes':
        sourceX = id === 'rim' ? -1 : .35; sourceY = id === 'rim' ? .7 : -1;
        approachX = sourceX * .25; approachY = sourceY * .25;
        order = id === 'rim' ? (u + .5) * .75 + (1 - v) * .25 : v * .6 + (u + .5) * .4;
        break;
      case 'staff':
        if (reach < .09) {
          sourceX = 0; sourceY = -1; approachX = 0; approachY = -.25;
          order = v * .7;
        } else {
          sourceX = side; sourceY = side * .65;
          bowX = side * .65; bowY = -side * .35;
          approachX = -side * .23; approachY = side * .15;
          order = .15 + (side < 0 ? v : 1 - v) * .8;
        }
        break;
      case 'lattice':
        sourceX = reach > .18 ? side : 0; sourceY = reach > .18 ? -1 : 1;
        approachX = sourceX * .18; approachY = sourceY * .25;
        order = reach > .18 ? v * .7 : .25 + (1 - v) * .75;
        break;
    }
    const depth = targets[j + 2] + (random() - .5) * .3;
    const perspective = 1 + depth * .28;
    const margin = .035 + random() * .1;
    const boundaryX = halfWidth * perspective + margin;
    const boundaryY = halfHeight * perspective + margin;
    // 沿指定切线与矩形视口求交，起点始终在屏外，不会排成一个统一圆环。
    const travelX = sourceX ? ((sourceX < 0 ? -boundaryX : boundaryX) - x) / sourceX : Infinity;
    const travelY = sourceY ? ((sourceY < 0 ? -boundaryY : boundaryY) - y) / sourceY : Infinity;
    const travel = Math.max(0, Math.min(travelX, travelY));
    origins[j] = x + sourceX * travel;
    origins[j + 1] = y + sourceY * travel;
    origins[j + 2] = depth;
    const jitterX = (random() - .5) * .07, jitterY = (random() - .5) * .07;
    // 控制点存相对落点的偏移，只在切图时规划；逐帧不再判断徽记或求三角函数。
    flightControl1[j] = (origins[j] - x) * .62 + bowX + jitterX;
    flightControl1[j + 1] = (origins[j + 1] - y) * .62 + bowY + jitterY;
    flightControl1[j + 2] = depth * .6;
    flightControl2[j] = approachX + jitterX * .4;
    flightControl2[j + 1] = approachY + jitterY * .4;
    flightControl2[j + 2] = (random() - .5) * .06;
    arrivalDelays[i] = (Math.max(0, Math.min(1, order)) * .65 + random() * .35) * FLIGHT_STAGGER;
    flightDurations[i] = FLIGHT_MIN + random() * FLIGHT_VARIATION;
  }
  return profile;
}
