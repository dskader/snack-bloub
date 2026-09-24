import {
  COMET_DOT,
  COMET_RIBBONS,
  DOT_PEAK,
  DOT_R,
  DOT_X,
  NOTIF_ANGLE,
  NOTIF_DIST,
  NOTIF_MARGIN,
  NOTIF_POP,
  NOTIF_R,
  RINGS,
  SWOOSH,
  particles,
  type ArcSpec,
  type DotRender
} from './decor'
import { EYE_H, EYE_SPLIT, EYE_W, REST_GAZE, type HeadGaze } from './face'
import type { BotHead, HeadMouth } from './head'
import { TAU, clamp, createRng, easings, lerp } from './math'
import {
  circle,
  hullOfCircles,
  polyPath,
  profileFromPolygon,
  silhouette,
  type Point,
  type Silhouette
} from './shape'

export interface EyeCfg {
  /** largeur locale (axe court de la gelule), en unites de rayon de boule */
  w: number
  /** hauteur locale (axe long) */
  h: number
  /** 1 = ouvert, 0 = ferme */
  open: number
  /**
   * Inclinaison propre de la gelule, en degres, positif = le haut part a
   * droite. Appliquee APRES le repere tangent de la sphere. Sans elle, les deux
   * yeux penchent forcement du meme cote (le roulis de tete) et la colere comme
   * la tristesse, qui demandent des inclinaisons en miroir, sont hors de portee.
   */
  tilt?: number
}

export interface Pose {
  /** silhouette du corps, en unites de rayon de boule */
  sil: Silhouette
  /** decalage global du corps ET des yeux */
  offX: number
  offY: number
  gaze: HeadGaze
  /** demi-ecart des yeux sur la sphere, en degres */
  split: number
  /** [oeil interieur, oeil exterieur] */
  eyes: [EyeCfg, EyeCfg]
  /** opacite des yeux : sert aux etats sans visage */
  eyeAlpha: number
  bodyAlpha: number
  dots: DotRender[]
  arcs: ArcSpec[]
  notif: { x: number; y: number; r: number; notch: number } | null
  /** true = le decor passe derriere le corps (particules de l'eclatement) */
  dotsBehind: boolean
  /** ouverture de la machoire, 0 = fermee, 1 = grande ouverte ; sans tete, sans effet */
  jaw: number
  /**
   * Deplacement ecran des deux yeux, en unites de boule. Sert aux poses de tete : leur
   * regard est ancre au visage du logo, et c'est ainsi qu'elles regardent ailleurs
   * sans faire pivoter la tete vers la bouche.
   */
  eyeShift: { x: number; y: number }
}

const pair = (w: number, h: number): [EyeCfg, EyeCfg] => [
  { w, h, open: 1 },
  { w, h, open: 1 }
]

function base(over: Partial<Pose> = {}): Pose {
  return {
    sil: circle(1),
    offX: 0,
    offY: 0,
    gaze: { ...REST_GAZE },
    split: EYE_SPLIT,
    eyes: pair(EYE_W, EYE_H),
    eyeAlpha: 1,
    bodyAlpha: 1,
    dots: [],
    arcs: [],
    notif: null,
    dotsBehind: false,
    jaw: 0,
    eyeShift: { x: 0, y: 0 },
    ...over
  }
}

/* --------------------------------------------------- formes non radiales */

/**
 * Barre du "!" vertical : enveloppe convexe de deux cercles.
 * Mesure : cercle haut (0, -0.505) r 0.132, cercle bas (0, +0.130) r 0.075,
 * flancs rectilignes. Elle est donc tronconique (rapport haut/bas 1.76).
 */
const BAR_UPRIGHT_CY = -0.1875
const BAR_UPRIGHT = profileFromPolygon(
  hullOfCircles(0, -0.505, 0.132, 0, 0.13, 0.075),
  0,
  BAR_UPRIGHT_CY
)

/** Barre du "!" penche : capsule pure (largeur constante 0.269, longueur 0.776). */
const BAR_ITALIC = profileFromPolygon(hullOfCircles(0, -0.2535, 0.1345, 0, 0.2535, 0.1345), 0, 0)

const barUpright = (pose: Partial<Silhouette> = {}): Silhouette => ({
  radii: [...BAR_UPRIGHT],
  rot: 0,
  cx: 0,
  cy: BAR_UPRIGHT_CY,
  sx: 1,
  sy: 1,
  ...pose
})

const barItalic = (pose: Partial<Silhouette> = {}): Silhouette => ({
  radii: [...BAR_ITALIC],
  rot: 0,
  cx: 0,
  cy: 0,
  sx: 1,
  sy: 1,
  ...pose
})

/**
 * Le point du "!" penche n'est pas un disque : c'est une goutte, bout rond
 * (r 0.118) du cote de la barre et pointe effilee a l'oppose, longueur 0.300
 * dans l'axe du glyphe. Centree sur le barycentre du bout rond.
 */
const TEAR = polyPath(hullOfCircles(0, 0, 0.118, 0, 0.172, 0.012))

/**
 * Le triangle ne tourne pas sur lui-meme : son centre decrit un cercle de
 * rayon 0.213 autour de l'origine (mesure). C'est ce decalage qui donne
 * l'impression qu'il bascule au lieu de pivoter sur place.
 */
const TRI_ORBIT = 0.213

function spinningTriangle(rot: number): Silhouette {
  return silhouette('triangle', {
    rot,
    cx: -TRI_ORBIT * Math.sin(rot),
    cy: TRI_ORBIT * Math.cos(rot)
  })
}

/* ------------------------------------------------------------------ etats */

export type StateId =
  | 'idle'
  | 'chomp'
  | 'thinking'
  | 'wink'
  | 'wide'
  | 'alert'
  | 'notify'
  | 'exclaim'
  | 'sleep'
  | 'egg'
  | 'hexagon'
  | 'play'
  | 'orbit'
  | 'burst'
  | 'comet'
  /** transition d'interface, pas une animation du catalogue : hors `SEQUENCE` */
  | 'swirl'

export interface StateDef {
  id: StateId
  /** duree de maintien quand la sequence complete est jouee */
  duration: number
  /**
   * duree en dessous de laquelle l'animation est coupee avant d'aboutir : le
   * "!" ne revient pas, le corps reste eclate. Elle se lit dans les constantes
   * de `pose` ci-dessous, elle ne se choisit pas. Absente = l'etat ignore le
   * temps ou boucle, n'importe quelle duree lui va (voir `MIN_BLOCK`).
   */
  minDuration?: number
  /** duree du morph d'entree */
  morph: number
  /** true = l'entree est masquee par un clignement, comme dans la video */
  blinkIn: boolean
  /**
   * true = le corps est la silhouette "au repos", donc remplacable par la forme
   * choisie dans le personnalisateur. Les etats qui dessinent leur propre forme
   * (le "!", les points, l'oeuf, le triangle...) valent false : c'est cette forme
   * la qui EST l'animation.
   */
  baseBody: boolean
  /**
   * true = l'etat porte le visage "au repos", donc remplacable par l'expression
   * choisie. Seul `idle` : les autres etats a visage ont une expression relevee
   * sur la video, c'est precisement ce qu'on reproduit.
   */
  baseFace: boolean
  pose(local: number): Pose
  /**
   * Variante jouee quand le corps est une TETE (`head.ts`). Son profil est remplace
   * par celui de la tete, qui garde donc sa silhouette, sa bouche et son visage ; les
   * effets de l'etat se posent autour. Le moteur la fond avec `pose` selon le poids de
   * la tete, donc changer de forme en plein etat morphe au lieu de sauter.
   *
   * Seulement la ou le decor ne suppose pas un corps rond : les anneaux d'`orbit` et
   * les particules de `burst` sont traces autour de la boule, et y restent.
   *
   * `head` est la tete en presence : une variante qui fait mordre la machoire (`chomp`)
   * lit `head.mouth` pour savoir s'il y en a une.
   */
  headPose?(local: number, head: BotHead): Pose
}

/** Onde de pulsation qui parcourt les trois points de gauche a droite. */
function dotPulse(t: number, index: number): number {
  const p = ((((t - index * 0.5) / 1.5) % 1) + 1) % 1
  const k = p < 0.5 ? 0.5 - 0.5 * Math.cos(p * TAU) : 0
  return clamp(k * 2)
}

/* ------------------------------------------------------------ poses de tete */

/*
 * Rien de ce qui suit n'est releve sur la video : ce sont les variantes CHOISIES des
 * etats quand le corps est la tete Snack, et l'etat `chomp`. Le visage y est celui du
 * logo — `pair(EYE_W, EYE_H)` et `REST_GAZE` sont renvoyes sur ses yeux par l'ancrage
 * de la tete — et le profil `circle(1)` des silhouettes est remplace par celui de la
 * tete : seuls comptent leur rotation, leur squash et leur decalage.
 *
 * Le decor se tient au-dessus a droite, hors de l'oreille droite (coin a 0,97 / -0,85).
 */

/** Deux yeux identiques inclines en miroir, comme `pair` d'`expressions.ts`. */
const mirrored = (w: number, h: number, tilt: number, open = 1): [EyeCfg, EyeCfg] => [
  { w, h, open, tilt },
  { w, h, open, tilt: -tilt }
]

/** Glyphe « Z » plein, demi-cote 1, trace a la taille voulue par `polyPath`. */
const Z_GLYPH: Point[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: -0.6 },
  { x: -0.34, y: 0.6 },
  { x: 1, y: 0.6 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0.6 },
  { x: 0.34, y: -0.6 },
  { x: -1, y: -0.6 }
]

/** Miette : un quadrilatere irregulier, pas un disque, pour ne pas lire des bulles. */
const CRUMB_GLYPH: Point[] = [
  { x: -1, y: -0.75 },
  { x: 0.85, y: -1 },
  { x: 1, y: 0.8 },
  { x: -0.8, y: 1 }
]

/** Bulle de pensee : trois points qui montent vers la droite, du plus petit au plus gros. */
const THOUGHT = [
  { x: 1.08, y: -0.92, r: 0.055 },
  { x: 1.24, y: -1.1, r: 0.078 },
  { x: 1.34, y: -1.3, r: 0.1 }
]

function thinkingHead(t: number): Pose {
  const look = easings.easeOutCubic(clamp(t / 0.45))
  const hum = 0.5 - 0.5 * Math.cos((t * TAU) / 1.3)
  return base({
    sil: circle(1, { rot: -0.035 * look }),
    // le regard monte vers la bulle, en translation : la tete ne pivote pas
    eyeShift: { x: 0.07 * look, y: -0.075 * look },
    eyes: pair(EYE_W, EYE_H * 0.92),
    // la bouche remue a peine, comme on mâchonne une idee
    jaw: 0.06 * hum * look,
    dots: THOUGHT.map((d, i) => {
      const k = dotPulse(t, i)
      const enter = easings.easeOutCubic(clamp((t - 0.15 - i * 0.2) / 0.3))
      return {
        x: d.x,
        y: d.y + (1 - enter) * 0.08,
        r: d.r * (0.6 + 0.4 * enter) * (1 + 0.2 * k),
        opacity: enter * (0.55 + 0.45 * k)
      }
    })
  })
}

/** Periode d'un souffle endormi ; les « Z » partent au meme rythme, decales d'un tiers. */
const SLEEP_BREATH = 2.4

function sleepHead(t: number): Pose {
  const breath = 0.5 - 0.5 * Math.cos((t * TAU) / SLEEP_BREATH)
  const settle = easings.easeOutCubic(clamp(t / 0.5))
  const zs: DotRender[] = []
  for (let k = 0; k < 3; k++) {
    const start = (k * SLEEP_BREATH) / 3
    if (t < start) continue
    const p = ((t - start) % SLEEP_BREATH) / SLEEP_BREATH
    const size = 0.045 + 0.06 * p
    zs.push({
      x: 1.04 + 0.36 * p + 0.05 * Math.sin(p * TAU),
      y: -0.78 - 0.6 * p,
      r: size,
      d: polyPath(Z_GLYPH, size),
      rot: -12 + 10 * Math.sin(p * TAU),
      opacity: Math.sin(p * Math.PI)
    })
  }
  return base({
    // la tete s'affaisse un peu et respire
    sil: circle(1, { sy: 1 + 0.03 * breath, sx: 1 - 0.012 * breath }),
    offY: 0.02 * settle,
    // yeux fermes : `open` a 0, le meme ecrasement que le clignement
    eyes: [
      { w: EYE_W * 1.15, h: EYE_H, open: 1 - settle },
      { w: EYE_W * 1.15, h: EYE_H, open: 1 - settle }
    ],
    // ronflement : la machoire s'entrouvre a l'inspiration
    jaw: 0.14 * breath * settle,
    dots: zs
  })
}

function playHead(t: number): Pose {
  const fade = clamp(t / 0.35) * clamp((2.2 - t) / 0.5)
  // petits sauts en rythme, deux par seconde
  const beat = Math.abs(Math.sin((t * Math.PI) / 0.5))
  const hop = beat * fade
  const land = (1 - beat) * fade
  return base({
    sil: circle(1, {
      rot: 0.07 * Math.sin((t * TAU) / 1) * fade,
      sx: 1 + 0.02 * land,
      sy: 1 - 0.03 * land
    }),
    offY: -0.07 * hop,
    eyes: mirrored(EYE_W * 1.1, EYE_H * lerp(1, 0.45, fade), 14 * fade),
    // elle chante en sautant
    jaw: 0.35 * hop,
    arcs: SWOOSH.map((s, i) => ({
      id: `sw${i}`,
      seed: { ...s, cx: 0.45 - t * 0.42 },
      t,
      opacity: fade
    }))
  })
}

/** Barre du « ! » de la tete : la capsule d'`alert`, reduite. */
const ALERT_BAR = hullOfCircles(0, -0.2535, 0.1345, 0, 0.2535, 0.1345)
const ALERT_TILT = 17.7

function alertHead(t: number): Pose {
  // accroupi, saut, reception : trois bosses qui ne se chevauchent pas
  const crouch = t < 0.18 ? easings.easeOutCubic(t / 0.18) : clamp(1 - (t - 0.18) / 0.1)
  const jump = t > 0.2 && t < 0.8 ? Math.sin((Math.PI * (t - 0.2)) / 0.6) : 0
  const land = t > 0.8 && t < 1.05 ? Math.sin((Math.PI * (t - 0.8)) / 0.25) * 0.6 : 0
  // le sursaut, puis tout se relache avant la fin mesuree de l'etat (2 s)
  const pop = easings.easeOutCubic(clamp((t - 0.2) / 0.2))
  const calm = clamp((t - 1.6) / 0.4)
  // le « ! » jaillit avec un leger depassement, qui appartient a cet etat seul
  const k = clamp((t - 0.25) / 0.3)
  const sc = (easings.easeOutCubic(k) + Math.sin(k * Math.PI) * 0.18) * 0.55
  const buzz = Math.sin(t * 2.5 * TAU) * 2.5 * pop
  const tilt = ((ALERT_TILT + buzz) * Math.PI) / 180
  const bx = 1.28
  const by = -1.1
  const bang = 1 - calm
  return base({
    sil: circle(1, {
      sx: 1 + 0.05 * crouch - 0.03 * jump + 0.04 * land,
      sy: 1 - 0.07 * crouch + 0.05 * jump - 0.05 * land
    }),
    offY: -0.13 * jump,
    eyes: pair(EYE_W * 1.2, EYE_H * (1 + 0.45 * pop * (1 - 0.35 * calm))),
    eyeShift: { x: 0, y: -0.03 * pop },
    // bouche bee, qui se referme en meme temps que le « ! » s'efface
    jaw: 0.55 * pop * (1 - calm),
    dots:
      sc > 0.001
        ? [
            {
              x: bx,
              y: by,
              r: 0.13 * sc,
              d: polyPath(ALERT_BAR, sc),
              rot: (tilt * 180) / Math.PI,
              opacity: bang
            },
            {
              x: bx - Math.sin(tilt) * 0.58 * sc,
              y: by + Math.cos(tilt) * 0.58 * sc,
              r: 0.118 * sc,
              opacity: bang
            }
          ]
        : []
  })
}

/* ---------------------------------------------------------------- croquer */

/** Debut de chaque bouchee ; chacune s'ouvre, tient, puis claque. */
const BITES = [0.1, 0.75, 1.4]
const BITE_OPEN = 0.28
const BITE_HOLD = 0.05
const BITE_SNAP = 0.07
/** instant ou la bouchee claque, depuis son debut */
const BITE_SHUT = BITE_OPEN + BITE_HOLD + BITE_SNAP
/** duree de l'ecrasement a l'impact, et de vie d'une miette */
const IMPACT = 0.09
const CRUMB_LIFE = 0.7
/** apres la derniere bouchee : mastication, puis mine satisfaite */
const CHEW_AT = BITES[BITES.length - 1]! + BITE_SHUT + 0.15

/** Ouverture de la machoire et force de l'impact a l'instant `t`. */
function bite(t: number): { jaw: number; impact: number } {
  let jaw = 0
  let impact = 0
  for (const b of BITES) {
    const u = t - b
    if (u < 0) continue
    if (u < BITE_OPEN) jaw = Math.max(jaw, easings.easeOutCubic(u / BITE_OPEN))
    else if (u < BITE_OPEN + BITE_HOLD) jaw = 1
    else if (u < BITE_SHUT) jaw = Math.max(jaw, 1 - ((u - BITE_OPEN - BITE_HOLD) / BITE_SNAP) ** 3)
    else impact = Math.max(impact, Math.exp(-(u - BITE_SHUT) / IMPACT))
  }
  if (t > CHEW_AT) jaw = Math.max(jaw, 0.12 * Math.abs(Math.sin(((t - CHEW_AT) * TAU) / 0.6)))
  return { jaw, impact }
}

/** Miettes tirees une fois pour toutes : deterministes, donc rejouables. */
const CRUMB_RNG = createRng(0x5aac)
const CRUMBS = BITES.flatMap((_, bouchee) =>
  Array.from({ length: 7 }, () => ({
    bouchee,
    u: CRUMB_RNG(),
    vx: (CRUMB_RNG() * 2 - 1) * 0.7,
    vy: -0.5 - CRUMB_RNG() * 0.9,
    size: 0.028 + CRUMB_RNG() * 0.03,
    spin: (CRUMB_RNG() * 2 - 1) * 540
  }))
)
const CRUMB_GRAVITY = 3.4

/** Les miettes de toutes les bouchees ; `origin(u)` dit d'ou part chacune. */
function crumbs(t: number, origin: (u: number) => Point): DotRender[] {
  const out: DotRender[] = []
  for (const c of CRUMBS) {
    const s = t - (BITES[c.bouchee]! + BITE_SHUT)
    if (s < 0 || s > CRUMB_LIFE) continue
    const p = origin(c.u)
    out.push({
      x: p.x + c.vx * s,
      y: p.y + c.vy * s + 0.5 * CRUMB_GRAVITY * s * s,
      r: c.size,
      d: polyPath(CRUMB_GLYPH, c.size),
      rot: c.spin * s,
      opacity: 1 - (s / CRUMB_LIFE) ** 2,
      // eclaircies vers le fond : lisibles sur le corps comme a cote
      depth: 0.45
    })
  }
  return out
}

/*
 * Le biscuit croque. Il se tient au coin de la bouche et perd un morceau a chaque
 * claquement, du cote de la bouche ; la derniere bouchee l'avale. Ses couleurs sont
 * fixes : c'est un objet pose devant le bot, pas une partie de lui.
 */
const COOKIE_R = 0.26
const COOKIE = '#e9a94b'
const COOKIE_CHIP = '#7a4a21'
/** morceaux croques, en unites du rayon du biscuit, depuis son centre */
const COOKIE_BITES = [
  { x: -0.95, y: -0.2, r: 0.55 },
  { x: -0.55, y: 0.35, r: 0.6 }
]
const COOKIE_CHIPS = [
  { x: 0.3, y: -0.35, r: 0.13 },
  { x: -0.2, y: 0.05, r: 0.11 },
  { x: 0.35, y: 0.35, r: 0.12 },
  { x: -0.55, y: -0.45, r: 0.1 }
]
const insideAny = (p: Point, holes: typeof COOKIE_BITES) =>
  holes.some((h) => Math.hypot(p.x - h.x, p.y - h.y) < h.r)

/** Contour du biscuit, rayon 1, apres les `n` premieres bouchees. */
const COOKIE_SHAPES = [0, 1, 2].map((n) => {
  const holes = COOKIE_BITES.slice(0, n)
  const pts: Point[] = []
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * TAU
    // bord legerement bossele, comme un vrai biscuit
    const r = 1 + 0.05 * Math.sin(a * 7 + 0.6)
    let p = { x: Math.cos(a) * r, y: Math.sin(a) * r }
    // un point croque est ramene sur le bord du morceau : l'encoche est une morsure
    for (const h of holes) {
      const d = Math.hypot(p.x - h.x, p.y - h.y)
      if (d < h.r) p = { x: h.x + ((p.x - h.x) / d) * h.r, y: h.y + ((p.y - h.y) / d) * h.r }
    }
    pts.push(p)
  }
  return { pts, chips: COOKIE_CHIPS.filter((c) => !insideAny(c, holes)) }
})

function cookie(t: number, at: Point): DotRender[] {
  const enter = easings.easeOutCubic(clamp(t / 0.25))
  const lastShut = BITES[BITES.length - 1]! + BITE_SHUT
  // avale d'un coup a la derniere bouchee
  const gone = clamp((t - lastShut + 0.03) / 0.06)
  const scale = COOKIE_R * enter * (1 - gone)
  if (scale <= 0.002) return []
  const eaten = BITES.filter((b) => t >= b + BITE_SHUT).length
  const shape = COOKIE_SHAPES[Math.min(eaten, COOKIE_SHAPES.length - 1)]!
  // il remonte vers la bouche pendant qu'elle s'ouvre
  const { jaw } = bite(t)
  const x = at.x + (1 - enter) * 0.3 - 0.05 * jaw
  const y = at.y - 0.03 * jaw
  const rot = -8 + 6 * Math.sin(t * 3)
  const c = Math.cos((rot * Math.PI) / 180)
  const s = Math.sin((rot * Math.PI) / 180)
  return [
    { x, y, r: scale, d: polyPath(shape.pts, scale), rot, opacity: enter, color: COOKIE },
    ...shape.chips.map((p) => ({
      x: x + (p.x * c - p.y * s) * scale,
      y: y + (p.x * s + p.y * c) * scale,
      r: p.r * scale,
      opacity: enter,
      color: COOKIE_CHIP
    }))
  ]
}

/** Sur une tete a bouche, les miettes partent des pointes du zigzag, bords exclus. */
const fromMouth = (mouth: HeadMouth) => {
  const tips = mouth.top.slice(1, -1)
  return (u: number) => tips[Math.floor(u * tips.length)]!
}
/** Sans bouche, du bas de la face. */
const fromChin = (u: number) => ({ x: (u * 2 - 1) * 0.55, y: 0.35 })
/** Sur une tete sans bouche, du bas de la joue, du cote du biscuit. */
const fromCheek = (u: number) => ({ x: 0.1 + u * 0.6, y: 0.3 })

/** Yeux pendant `chomp` : un peu plus grands a l'ouverture, plisses au claquement. */
function chompEyes(t: number, jaw: number, impact: number): [EyeCfg, EyeCfg] {
  const content = clamp((t - CHEW_AT) / 0.25)
  const h = lerp(Math.max(0.3, 1 + 0.12 * jaw - 0.6 * impact), 0.45, content)
  return mirrored(EYE_W * (1 + 0.1 * impact), EYE_H * h, 12 * content)
}

function chompBall(t: number): Pose {
  const { jaw, impact } = bite(t)
  return base({
    // sans machoire, la boule s'etire a l'ouverture et s'ecrase au claquement
    sil: circle(1, { sx: 1 - 0.03 * jaw + 0.05 * impact, sy: 1 + 0.06 * jaw - 0.06 * impact }),
    offY: 0.02 * impact,
    eyes: chompEyes(t, jaw, impact),
    dots: [...cookie(t, { x: 1.02, y: 0.28 }), ...crumbs(t, fromChin)]
  })
}

function chompHead(t: number, head: BotHead): Pose {
  const { jaw, impact } = bite(t)
  if (!head.mouth) {
    // sans machoire, la tete mord comme la boule : elle s'etire puis s'ecrase
    return base({
      sil: circle(1, { sx: 1 - 0.03 * jaw + 0.05 * impact, sy: 1 + 0.05 * jaw - 0.05 * impact }),
      offY: 0.015 * impact,
      eyes: chompEyes(t, jaw, impact),
      dots: [...cookie(t, { x: 1.12, y: 0.22 }), ...crumbs(t, fromCheek)]
    })
  }
  return base({
    sil: circle(1, { sx: 1 + 0.03 * impact - 0.01 * jaw, sy: 1 - 0.035 * impact }),
    offY: 0.015 * impact,
    eyes: chompEyes(t, jaw, impact),
    jaw,
    // au coin droit de la bouche, la ou le zigzag rejoint le bord
    dots: [...cookie(t, { x: 1.16, y: 0.12 }), ...crumbs(t, fromMouth(head.mouth))]
  })
}

export const STATES: StateDef[] = [
  {
    id: 'idle',
    duration: 2.4,
    morph: 0.45,
    blinkIn: false,
    baseFace: true,
    baseBody: true,
    pose: () => base()
  },

  {
    /**
     * Snack croque : trois bouchees qui s'ouvrent, tiennent et claquent, des miettes a
     * chaque claquement, puis une mastication satisfaite. Pas un etat de la video : il
     * est CHOISI, pour la tete Snack dont la machoire s'ouvre vraiment. Sur une autre
     * forme, et sur les tetes sans bouche, le corps s'etire et s'ecrase a la place.
     */
    id: 'chomp',
    duration: 2.6,
    // la derniere bouchee claque a 1.4 + 0.4, et son ecrasement est retombe 0.3 s plus tard
    minDuration: 2.1,
    morph: 0.4,
    blinkIn: false,
    baseFace: false,
    baseBody: true,
    pose: chompBall,
    headPose: chompHead
  },

  {
    id: 'thinking',
    duration: 2.6,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    headPose: thinkingHead,
    pose: (t) => {
      const mid = dotPulse(t, 1)
      // Les points lateraux sortent des flancs de la boule : dans la video ils
      // restent fusionnes avec elle 1-2 frames avant de se detacher.
      const emerge = 0.3 + 0.7 * easings.easeOutCubic(clamp(t / 0.3))
      return base({
        // la boule DEVIENT le point du milieu : le morph reste continu
        sil: circle(DOT_R * (1 + (DOT_PEAK - 1) * mid), { cx: DOT_X[1]! }),
        eyeAlpha: 0,
        dots: [0, 2].map((i) => {
          const k = dotPulse(t, i)
          return {
            x: DOT_X[i]! * emerge,
            y: 0,
            r: DOT_R * (1 + (DOT_PEAK - 1) * k),
            opacity: 0.55 + 0.45 * k
          }
        })
      })
    }
  },

  {
    id: 'wink',
    duration: 1.6,
    morph: 0.3,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () =>
      base({
        gaze: { yaw: -5.37, pitch: 4.55, roll: 6.7 },
        split: 16.25,
        // L'oeil ferme n'est pas l'oeil ouvert ecrase : c'est un tiret
        // horizontal PLUS LARGE que l'oeil ouvert (0.447 contre 0.236).
        eyes: [
          { w: 0.236, h: 0.464, open: 1 },
          { w: 0.447, h: 0.089, open: 1 }
        ]
      })
  },

  {
    id: 'wide',
    duration: 1.8,
    morph: 0.55,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: () =>
      base({
        gaze: { yaw: 6.92, pitch: -21.96, roll: 11.6 },
        split: 18.43,
        eyes: pair(0.356, 0.875)
      })
  },

  {
    id: 'alert',
    duration: 2.4,
    // le "!" revient en place a 1.6 + 0.4
    minDuration: 2,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    headPose: alertHead,
    pose: (t) => {
      // Course mesuree : -0.087 -> +0.732 en 1.5 s, ease-in-out, micro-overshoot.
      const p = clamp(t / 1.5)
      const travel = easings.easeInOutCubic(p) * 0.82 - 0.087
      const back = t > 1.6 ? clamp((t - 1.6) / 0.4) : 0
      const x = travel * (1 - back) + 0.1 * back
      // Vibration secondaire a 2.5 Hz, barre et point en opposition de phase.
      const buzz = Math.sin(t * 2.5 * TAU) * 0.005
      const tilt = (17.7 * Math.PI) / 180
      return base({
        sil: barItalic({ rot: tilt, cx: x, cy: -0.325 - buzz }),
        eyeAlpha: 0,
        dots: [
          {
            // le point suit l'axe du glyphe, a 0.580 du centre de la barre
            x: x - Math.sin(tilt) * 0.58,
            y: -0.325 + Math.cos(tilt) * 0.58 + buzz * 2.8,
            r: 0.118,
            d: TEAR,
            rot: (tilt * 180) / Math.PI,
            opacity: 1
          }
        ]
      })
    }
  },

  {
    id: 'notify',
    duration: 2.2,
    morph: 0.5,
    blinkIn: true,
    baseFace: false,
    baseBody: true,
    pose: (t) => {
      // Pop du point bleu : pic a +14 % vers 0.3 s puis stabilisation.
      const p = clamp(t / 0.45)
      const pop = 1 + (NOTIF_POP - 1) * Math.sin(p * Math.PI) * (1 - p * 0.35)
      const r = NOTIF_R * (p < 1 ? pop : 1)
      const a = (NOTIF_ANGLE * Math.PI) / 180
      return base({
        // le regard part a l'oppose de la pastille
        gaze: { yaw: -21.94, pitch: -5.82, roll: -12.2 },
        split: 18.89,
        eyes: pair(0.505, 0.498),
        notif: {
          x: Math.cos(a) * NOTIF_DIST,
          y: Math.sin(a) * NOTIF_DIST,
          r,
          notch: r + NOTIF_MARGIN
        }
      })
    }
  },

  {
    id: 'exclaim',
    duration: 2,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: () =>
      base({
        sil: barUpright(),
        eyeAlpha: 0,
        dots: [{ x: -0.012, y: 0.526, r: 0.113, opacity: 1 }]
      })
  },

  {
    id: 'sleep',
    duration: 2.4,
    morph: 0.5,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    headPose: sleepHead,
    pose: (t) =>
      base({
        // Rebond vertical mesure : +-0.19 autour de +0.11, periode 0.6 s.
        sil: circle(0.1585, { cy: 0.11 + Math.sin(t * (TAU / 0.6)) * 0.19 }),
        eyeAlpha: 0
      })
  },

  {
    id: 'egg',
    duration: 1.8,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: () =>
      base({
        sil: silhouette('egg'),
        gaze: { yaw: 19.97, pitch: 26.01, roll: -17.1 },
        // les yeux se resserrent comme le corps
        split: 11.07,
        eyes: pair(0.164, 0.385)
      })
  },

  {
    id: 'hexagon',
    duration: 1.6,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    pose: () =>
      base({
        sil: silhouette('hexagon'),
        gaze: { yaw: 23.11, pitch: 24.42, roll: -13.3 },
        split: 13.37,
        eyes: pair(0.177, 0.411)
      })
  },

  {
    id: 'play',
    duration: 2,
    morph: 0.5,
    baseFace: false,
    baseBody: false,
    blinkIn: true,
    headPose: playHead,
    pose: (t) => {
      // Le triangle reste quasi immobile pendant que le bouquet le traverse.
      const fade = clamp(t / 0.35) * clamp((2.2 - t) / 0.5)
      return base({
        sil: spinningTriangle(0),
        gaze: { yaw: 12, pitch: -8, roll: -6 },
        split: 15,
        eyes: pair(0.18, 0.34),
        // le bouquet balaie de la droite vers la gauche par-dessus le triangle
        arcs: SWOOSH.map((s, i) => ({
          id: `sw${i}`,
          seed: { ...s, cx: 0.45 - t * 0.42 },
          t,
          opacity: fade
        }))
      })
    }
  },

  {
    id: 'orbit',
    duration: 3.4,
    // le corps a fini de se relacher du triangle vers la boule a 1.6 + 0.9
    minDuration: 2.5,
    morph: 0.6,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      // Rotation mesuree : rampe sur 0.35 s puis 1.25 tour/s (sens antihoraire).
      const ramp = easings.easeInOutCubic(clamp(t / 0.35))
      const rot = -TAU * 1.25 * t * ramp
      // Le corps se relache du triangle vers la boule pendant l'orbite.
      const back = easings.easeInOutCubic(clamp((t - 1.6) / 0.9))
      const tri = spinningTriangle(rot)
      const ball = circle(1, { rot })
      const sil: Silhouette = {
        radii: tri.radii.map((r, i) => r + (ball.radii[i]! - r) * back),
        rot,
        cx: tri.cx * (1 - back),
        cy: tri.cy * (1 - back),
        sx: 1,
        sy: 1
      }
      const fade = clamp(t / 0.8) * clamp((3.6 - t) / 0.9)
      return base({
        sil,
        // les yeux filent autour de la sphere ~3x plus vite que la silhouette
        gaze: {
          yaw: REST_GAZE.yaw + Math.sin(t * 6.5) * 65 * (1 - back),
          pitch: -4 + back * 32,
          roll: -13
        },
        eyes: pair(0.18, 0.34 + back * 0.07),
        // les anneaux entrent un par un sur 0.8 s
        arcs: RINGS.map((s, i) => ({
          id: `rg${i}`,
          seed: s,
          t,
          opacity: fade * clamp((t - i * 0.13) / 0.3)
        }))
      })
    }
  },

  {
    /**
     * Entree dans la vue des reglages.
     *
     * SEUL etat qui n'est pas releve sur la video : il est CHOISI, comme la
     * couleur `--ink`. Il emprunte le vocabulaire d'`orbit` — les memes anneaux,
     * avec leurs parametres mesures — mais coupe court : 1 s au lieu de 3,4, la
     * moitie des anneaux, et aucun triangle.
     *
     * Les deux drapeaux a `true` sont tout l'interet de cet etat :
     *
     * - `baseBody` laisse la forme choisie remplacer le corps, donc la vue peut
     *   imposer le cercle et le galet ou la goutte y MORPHENT au lieu de sauter ;
     * - `baseFace` fait porter le visage de repos, donc le suivi du curseur
     *   s'applique des cette entree. Un etat qui aurait sa propre pose de regard
     *   (comme `orbit`) rendrait la main a l'etat suivant en pleine course, et
     *   les yeux sauteraient d'un coup a la reprise.
     *
     * Il n'est volontairement PAS dans `SEQUENCE` : ce n'est pas une animation du
     * catalogue, c'est une transition d'interface.
     */
    id: 'swirl',
    // un peu plus que le tour du regard (`TURN_TIME`, 1,1 s) : les yeux doivent
    // etre poses a gauche avant que les anneaux ne s'effacent
    duration: 1.3,
    minDuration: 1.3,
    morph: 0.3,
    baseFace: true,
    baseBody: true,
    // le morph de forme est masque par un clignement, comme partout ailleurs
    blinkIn: true,
    pose: (t) =>
      base({
        // trois anneaux sur les six d'`orbit` : la moitie du bouquet suffit a le
        // reconnaitre, et c'est autant d'arcs en moins a rasteriser par image
        arcs: RINGS.slice(0, 3).map((s, i) => ({
          id: `sw${i}`,
          seed: s,
          t,
          // ils entrent l'un apres l'autre puis s'effacent avant la fin du bloc,
          // pour que la reprise au repos se fasse sur une image deja propre
          opacity: clamp((t - i * 0.06) / 0.14) * clamp((1.22 - t) / 0.34)
        }))
      })
  },

  {
    id: 'burst',
    duration: 2.6,
    // le corps est recompose a 1.7 + 0.7
    minDuration: 2.4,
    morph: 0.4,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      // Effondrement mesure : 1.0 -> 0.166 en 0.7 s, ease-out, sans rebond.
      const collapse = 1 - 0.834 * easings.easeOutQuint(clamp(t / 0.7))
      const regrow = easings.easeOutQuint(clamp((t - 1.7) / 0.7))
      return base({
        sil: circle(collapse + (1 - collapse) * regrow),
        eyeAlpha: clamp((t - 1.85) / 0.4),
        dots: particles(t, 1),
        dotsBehind: true
      })
    }
  },

  {
    id: 'comet',
    duration: 2.4,
    // le point se recompose a 1.85 + 0.6 = 2.45, soit 0.05 s apres la coupe de
    // la video : ce reliquat se termine pendant le fondu suivant, comme dans la
    // reference. On ne descend donc pas sous la duree mesuree.
    minDuration: 2.4,
    morph: 0.45,
    baseFace: false,
    baseBody: false,
    blinkIn: false,
    pose: (t) => {
      const collapse = 1 - (1 - COMET_DOT) * easings.easeOutQuint(clamp(t / 0.55))
      const regrow = easings.easeOutQuint(clamp((t - 1.85) / 0.6))
      const fade = clamp((t - 0.15) / 0.25) * clamp((1.95 - t) / 0.3)
      return base({
        // Le point derive de 0.035 vers le bas puis remonte (wobble mesure).
        sil: circle(collapse + (1 - collapse) * regrow, {
          cy: Math.sin(clamp(t / 1.7) * Math.PI) * 0.035
        }),
        eyeAlpha: clamp((t - 2) / 0.35),
        arcs: COMET_RIBBONS.map((s, i) => ({ id: `cm${i}`, seed: s, t, opacity: fade }))
      })
    }
  }
]

export const STATE_BY_ID = new Map(STATES.map((s) => [s.id, s]))

/** Ordre de lecture de la sequence complete, calque sur la video de reference. */
/**
 * Date, en temps local, ou chaque etat est le plus lisible : c'est la pose que
 * montrent les vignettes et la planche. Rendu deterministe, donc comparable
 * d'une execution a l'autre. Le type force a couvrir tout nouvel etat.
 */
export const POSES: Record<StateId, number> = {
  idle: 1,
  // premiere bouchee grande ouverte
  chomp: 0.4,
  thinking: 1.1,
  wink: 0.8,
  wide: 0.8,
  alert: 0.75,
  notify: 0.9,
  exclaim: 0.8,
  sleep: 0.45,
  egg: 0.8,
  hexagon: 0.8,
  play: 0.9,
  orbit: 1.2,
  swirl: 0.5,
  burst: 0.45,
  comet: 1.15
}

export const SEQUENCE: StateId[] = [
  'idle',
  'chomp',
  'thinking',
  'wink',
  'wide',
  'alert',
  'notify',
  'exclaim',
  'sleep',
  'egg',
  'hexagon',
  'play',
  'orbit',
  'burst',
  'comet'
]
