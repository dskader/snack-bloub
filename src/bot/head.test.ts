import { describe, expect, it } from 'vitest'
import { EYE_SPLIT, eyePoses } from './face'
import { SNACK_HEAD, SNACK_NO_MOUTH_HEAD, type BotHead } from './head'
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

  it("la tete sans bouche n'a ni bouche ni machoire", () => {
    expect(SNACK_NO_MOUTH_HEAD.mouth).toBeUndefined()
    expect(SNACK_HEAD.mouth).toBeDefined()
  })
})
