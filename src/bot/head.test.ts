import { describe, expect, it } from 'vitest'
import { EYE_SPLIT, eyePoses } from './face'
import { SNACK_HEAD, SNACK_NO_MOUTH_HEAD, SNACK_SHIELD_HEAD, type BotHead } from './head'
import { radiusAtAngle } from './shape'
import { SNACK_EYES } from './snack'
import { SNACK_NO_MOUTH_EYES } from './snack-no-mouth'

/**
 * Centres des yeux du visage neutre sur la tete, tels que le moteur les pose : visee de
 * l'ancrage, demi-ecart ajuste, puis prorata du rayon du profil dans leur direction.
 */
function centres(head: BotHead) {
  const { face } = head
  return eyePoses(face.gaze, 1, EYE_SPLIT * face.split).map((e) => {
    const fit = radiusAtAngle(head.radii, Math.atan2(e.y, e.x))
    return { x: e.x * fit, y: e.y * fit }
  })
}

describe('ancrage du visage des tetes', () => {
  /*
   * L'ancrage est un ajustement sur l'image, pas un reglage : regenerer `snack.ts` ou
   * `snack-no-mouth.ts` sans le reprendre deplacerait les yeux hors de ceux du dessin.
   */
  for (const [nom, head, yeux] of [
    ['logo', SNACK_HEAD, SNACK_EYES],
    ['sans bouche', SNACK_NO_MOUTH_HEAD, SNACK_NO_MOUTH_EYES]
  ] as const) {
    it(`pose les yeux neutres sur ceux du dessin (${nom})`, () => {
      const c = centres(head)
      for (let i = 0; i < 2; i++) {
        expect(Math.hypot(c[i]!.x - yeux[i]!.x, c[i]!.y - yeux[i]!.y), `oeil ${i}`).toBeLessThan(0.002)
      }
    })
  }

  /*
   * Le bouclier n'a pas d'yeux dessines : son visage est choisi (proportions de la tete
   * sans bouche, yeux plus ecartes) et c'est ce choix qu'on verrouille. De face,
   * symetrique, a 0,32 de la hauteur, 0,451 entre centres.
   */
  it('pose les yeux neutres du bouclier de face, symetriques, sous le front', () => {
    const [g, d] = centres(SNACK_SHIELD_HEAD)
    expect(Math.abs(g!.x + d!.x)).toBeLessThan(0.002)
    expect(Math.abs(g!.y - d!.y)).toBeLessThan(0.002)
    expect(Math.hypot(d!.x - g!.x, d!.y - g!.y)).toBeCloseTo(0.451, 3)
    expect((g!.y + d!.y) / 2).toBeCloseTo(-0.258, 3)
  })

  it("les tetes sans bouche n'ont ni bouche ni machoire", () => {
    expect(SNACK_NO_MOUTH_HEAD.mouth).toBeUndefined()
    expect(SNACK_SHIELD_HEAD.mouth).toBeUndefined()
    expect(SNACK_HEAD.mouth).toBeDefined()
  })
})
