import { EYE_H, EYE_SPLIT, EYE_W, type HeadGaze } from './face'
import { clamp, lerp } from './math'
import { profileFromPolygon, type Point } from './shape'
import {
  SNACK_JAW,
  SNACK_MOUTH_BOTTOM,
  SNACK_MOUTH_TOP,
  SNACK_OUTLINE,
  SNACK_OUTLINE_OPEN
} from './snack'

/**
 * Une TETE : une forme du personnalisateur qui porte son propre visage, une bouche
 * percee dans le corps et une machoire qui s'ouvre. Seule la tete Snack en est une.
 *
 * Tout est en unites de boule, dans le repere du profil : ce qui est perce dans le
 * corps suit donc sa rotation, son squash et son decalage.
 */

/**
 * Visage propre a une tete : la transformation qui envoie le visage NEUTRE releve sur
 * la video sur celui de la tete. Le moteur l'applique a tout visage pose sur elle —
 * expressions, clin d'oeil, yeux ecarquilles, suivi du pointeur — qui s'animent donc
 * autour des yeux de la tete et non autour de ceux de la boule.
 */
export interface FaceAnchor {
  /** orientation de la tete pour le visage neutre, degres */
  gaze: HeadGaze
  /**
   * Part de l'ecart au neutre que la tete conserve. Sur la boule, une expression
   * deplace le regard de 20deg et plus ; sur une tete ou le visage n'occupe qu'une
   * bande, ce meme ecart envoie les yeux dans la bouche.
   */
  gain: number
  /**
   * Part conservee de la derive du regard au repos. Les yeux du logo sont a quelques
   * unites d'une pointe du zigzag : la derive entiere de la boule les y fait toucher.
   */
  wander: number
  /** facteur sur le demi-ecart des yeux */
  split: number
  /** facteurs de taille ; `w` par oeil (0 = interieur, 1 = exterieur) */
  w: [number, number]
  h: number
  /** part conservee de ce qui depasse la taille du neutre : le front est etroit */
  growth: number
  /** ecart d'inclinaison propre de chaque oeil, degres */
  tilt: number
}

/** Charniere de la machoire grande ouverte ; une ouverture `f` en applique `f`. */
export interface Jaw {
  pivot: Point
  drop: number
  /** degres, sens horaire a l'ecran */
  tilt: number
}

export interface BotHead {
  /** profil machoire fermee : c'est celui de la forme au catalogue */
  radii: number[]
  /** profils releves machoire ouverte, par ouverture croissante, 0 compris */
  open: Array<{ open: number; radii: number[] }>
  /** bords de la bouche de gauche a droite ; le bas suit la machoire */
  mouthTop: Point[]
  mouthBottom: Point[]
  jaw: Jaw
  face: FaceAnchor
}

/**
 * Profil de la tete machoire ouverte a `open`, interpole entre les deux releves qui
 * l'encadrent. Les releves sont faits sur l'image — machoire deplacee au pixel puis
 * contour relance — et non en deformant le profil ferme : la machoire qui tombe
 * decouvre des flancs qu'aucun rayon du profil ferme ne touchait.
 */
export function headRadii(head: BotHead, open: number): number[] {
  const o = clamp(open)
  if (o <= 0) return head.radii
  const steps = head.open
  let i = 1
  while (i < steps.length - 1 && steps[i]!.open < o) i++
  const a = steps[i - 1]!
  const b = steps[i]!
  const k = clamp((o - a.open) / (b.open - a.open))
  return a.radii.map((r, j) => lerp(r, b.radii[j]!, k))
}

/** Point du bas de la bouche deplace avec la machoire ouverte a `open`. */
export function jawPoint(head: BotHead, p: Point, open: number): Point {
  const o = clamp(open)
  const th = (head.jaw.tilt * o * Math.PI) / 180
  const c = Math.cos(th)
  const s = Math.sin(th)
  const { x: px, y: py } = head.jaw.pivot
  const dx = p.x - px
  const dy = p.y - py
  return { x: c * dx - s * dy + px, y: s * dx + c * dy + py + head.jaw.drop * o }
}

/** Polygone de la bouche, machoire ouverte a `open`. */
export function mouthOf(head: BotHead, open: number): Point[] {
  const bas = open > 0 ? head.mouthBottom.map((p) => jawPoint(head, p, open)) : head.mouthBottom
  return [...head.mouthTop, ...[...bas].reverse()]
}

/**
 * Tete Snack. Le visage a ete ajuste pour que, sur ce profil, les yeux du neutre
 * tombent exactement sur ceux du logo (`SNACK_EYES`, ecart residuel nul) : tete a
 * yaw -12,52 / pitch 26,12 / roll -14,98, demi-ecart 9,77deg, gelules de
 * 0,162 et 0,157 x 0,269 inclinees de 16,7deg. Tailles et inclinaison compensent le
 * raccourci de la sphere a cette orientation : a l'ecran les deux ovales font
 * 0,157 x 0,237 et penchent de 6deg, comme sur le logo.
 */
export const SNACK_HEAD: BotHead = {
  radii: profileFromPolygon(SNACK_OUTLINE, 0, 0),
  open: [
    { open: 0, radii: profileFromPolygon(SNACK_OUTLINE, 0, 0) },
    ...SNACK_OUTLINE_OPEN.map((s) => ({ open: s.open, radii: profileFromPolygon(s.outline, 0, 0) }))
  ],
  mouthTop: SNACK_MOUTH_TOP,
  mouthBottom: SNACK_MOUTH_BOTTOM,
  jaw: SNACK_JAW,
  face: {
    gaze: { yaw: -12.52, pitch: 26.12, roll: -14.98 },
    gain: 0.1,
    wander: 0.3,
    split: 9.77 / EYE_SPLIT,
    w: [0.162 / EYE_W, 0.157 / EYE_W],
    h: 0.269 / EYE_H,
    growth: 0.45,
    tilt: 16.7
  }
}
