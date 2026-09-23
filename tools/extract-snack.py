#!/usr/bin/env python3
"""Regenere src/bot/snack.ts a partir du logo Snack (tools/snack-logo-reference.png).

Comme les profils de la video, la tete Snack n'est pas dessinee a la main : on la
releve au pixel sur le logo.

Le logo est coupe de part en part par la bouche en zigzag : il est fait de DEUX
morceaux (la tete et la machoire). Un profil radial ne decrit qu'un contour
exterieur, donc on releve separement :

- la silhouette PLEINE (tete + machoire + l'espace de la bouche comble colonne par
  colonne), qui devient le profil radial du corps ;
- la bouche, qui devient un trou dans le masque, exactement comme les yeux. Corps
  plein moins bouche redonne le logo au pixel pres.

Usage :
    python3 tools/extract-snack.py > src/bot/snack.ts
"""
import math

import numpy as np
from PIL import Image
from scipy import ndimage

SOURCE = 'tools/snack-logo-reference.png'
# Rayon de la boule equivalente : la silhouette pleine est mise a l'echelle pour
# avoir l'aire d'un disque de ce rayon, en unites de boule.
AREA_R = 1.0
# Nombre de rayons du contour dense. `profileFromPolygon` le reechantillonne ensuite
# aux angles communs du moteur.
RAYS = 360
# Prolongement de la bouche au-dela du contour, en pixels du logo : le profil lisse
# du corps deborde un peu du vrai bord, et sans marge une fine lamelle bleue
# refermerait la bouche sur les cotes.
MOUTH_OVERSHOOT = 40
# Tolerance de simplification des polylignes, en pixels du logo.
RDP_EPS = 1.2
# Machoire grande ouverte (etat `chomp`) : elle tombe de JAW_DROP pixels et pivote de
# JAW_TILT degres (sens horaire a l'ecran) autour de son centroide. Les profils
# intermediaires sont releves a ces fractions d'ouverture, 0 etant le logo.
JAW_DROP = 72
JAW_TILT = 5.0
JAW_STEPS = (1 / 3, 2 / 3, 1)


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a = np.array(pts[0], float)
    b = np.array(pts[-1], float)
    ab = b - a
    n = np.hypot(*ab) or 1e-9
    best, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        p = np.array(pts[i], float) - a
        d = abs(ab[0] * p[1] - ab[1] * p[0]) / n
        if d > best:
            best, idx = d, i
    if best <= eps:
        return [pts[0], pts[-1]]
    return rdp(pts[: idx + 1], eps)[:-1] + rdp(pts[idx:], eps)


def main():
    im = np.asarray(Image.open(SOURCE).convert('RGB')).astype(int)
    blue = (im[:, :, 2] > 180) & (im[:, :, 0] < 150) & (im[:, :, 2] - im[:, :, 0] > 80)
    color = np.median(im[blue], axis=0).round().astype(int)

    labels, count = ndimage.label(blue)
    sizes = ndimage.sum(blue, labels, range(1, count + 1))
    order = np.argsort(sizes)[::-1][:2] + 1
    parts = [labels == i for i in order]
    parts.sort(key=lambda m: np.nonzero(m)[0].mean())
    head, jaw = parts
    body = head | jaw

    h, w = blue.shape

    def fill_gap(head, jaw):
        """Espace de la bouche : entre le bas de la tete et le haut de la machoire."""
        mouth = np.zeros_like(head)
        top_edge, bottom_edge = [], []
        for x in range(head.shape[1]):
            hy = np.nonzero(head[:, x])[0]
            jy = np.nonzero(jaw[:, x])[0]
            if len(hy) == 0 or len(jy) == 0:
                continue
            y0, y1 = hy.max() + 1, jy.min()
            if y1 <= y0:
                continue
            mouth[y0:y1, x] = True
            top_edge.append((x, y0))
            bottom_edge.append((x, y1))
        return mouth, top_edge, bottom_edge

    mouth, top_edge, bottom_edge = fill_gap(head, jaw)
    full = body | mouth
    ys, xs = np.nonzero(full)
    area = full.sum()
    cx, cy = xs.mean(), ys.mean()
    px = math.sqrt(area / math.pi) / AREA_R

    def rays(mask):
        """Contour dense : le point plein le plus lointain sur chaque rayon, sous-pixel."""
        mh, mw = mask.shape
        out = []
        for k in range(RAYS):
            a = 2 * math.pi * k / RAYS
            dx, dy = math.cos(a), math.sin(a)
            r, last = 0.0, 0.0
            while r < max(mw, mh):
                x, y = int(round(cx + dx * r)), int(round(cy + dy * r))
                if 0 <= x < mw and 0 <= y < mh and mask[y, x]:
                    last = r
                r += 0.25
            out.append(((dx * last) / px, (dy * last) / px))
        return out

    outline = rays(full)

    # machoire ouverte : meme repere et meme echelle que la silhouette fermee, sur un
    # canevas agrandi vers le bas pour qu'elle ne sorte pas de l'image
    jy, jx = np.nonzero(jaw)
    pivot = (jx.mean(), jy.mean())
    pad = JAW_DROP * 2
    open_outlines = []
    for f in JAW_STEPS:
        th = math.radians(JAW_TILT * f)
        c, s = math.cos(th), math.sin(th)
        d = JAW_DROP * f
        big_jaw = np.zeros((h + pad, w), bool)
        big_jaw[:h] = jaw
        m = np.array([[c, -s], [s, c]])
        py_, px_ = pivot[1], pivot[0]
        offset = np.array([py_, px_]) - m @ np.array([py_ + d, px_])
        moved = ndimage.affine_transform(big_jaw.astype(float), m, offset=offset, order=1) > 0.5
        big_head = np.zeros_like(moved)
        big_head[:h] = head
        gap, _, _ = fill_gap(big_head, moved)
        open_outlines.append(rays(big_head | moved | gap))

    # bouche : bord haut de gauche a droite, bord bas de droite a gauche,
    # prolongee horizontalement au-dela du contour des deux cotes
    def extend(edge):
        (x0, y0), (x1, y1) = edge[0], edge[-1]
        return [(x0 - MOUTH_OVERSHOOT, y0)] + edge + [(x1 + MOUTH_OVERSHOOT, y1)]

    unit = lambda P: [((x - cx) / px, (y - cy) / px) for x, y in P]
    top = unit(rdp(extend(top_edge), RDP_EPS))
    bottom = unit(rdp(extend(bottom_edge), RDP_EPS))

    # yeux : les trous fermes dans la tete
    holes = ndimage.binary_fill_holes(head) & ~head
    hl, hn = ndimage.label(holes)
    eyes = []
    for i in range(1, hn + 1):
        m = hl == i
        if m.sum() < 200:
            continue
        ey, ex = np.nonzero(m)
        mx, my = ex.mean(), ey.mean()
        cov = np.cov(np.vstack([ex - mx, ey - my]))
        vals, vecs = np.linalg.eigh(cov)
        major = vecs[:, 1]
        # angle de l'axe long par rapport a la verticale, positif = le haut part a droite
        tilt = math.degrees(math.atan2(major[0], -major[1]))
        if tilt > 90:
            tilt -= 180
        if tilt < -90:
            tilt += 180
        # ellipse pleine : demi-axe = 2 ecarts-types
        eyes.append(
            {
                'x': (mx - cx) / px,
                'y': (my - cy) / px,
                'w': 4 * math.sqrt(vals[0]) / px,
                'h': 4 * math.sqrt(vals[1]) / px,
                'tilt': tilt,
            }
        )
    eyes.sort(key=lambda e: e['x'])

    f = lambda v: f'{v:.4f}'
    pts = lambda P: ',\n  '.join(f'{{ x: {f(x)}, y: {f(y)} }}' for x, y in P)
    hexc = '#' + ''.join(f'{c:02x}' for c in color)

    print('// Tete Snack relevee au pixel sur le logo (tools/snack-logo-reference.png).')
    print('// Repere : centre = centroide de la silhouette pleine, y vers le bas.')
    print(f'// Unite : la silhouette pleine a l\'aire d\'un disque de rayon {AREA_R}.')
    print('//')
    print('// Genere par tools/extract-snack.py — ne pas editer a la main.')
    print()
    print("import type { Point } from './shape'")
    print()
    print(f"export const SNACK_BLUE = '{hexc}'")
    print()
    print('/** Contour exterieur de la silhouette pleine, bouche comblee. */')
    print(f'export const SNACK_OUTLINE: Point[] = [\n  {pts(outline)}\n]')
    print()
    print('/**')
    print(' * Bords de la bouche en zigzag, de gauche a droite, prolonges au-dela du contour des')
    print(' * deux cotes. Le haut appartient a la tete, le bas a la machoire : c\'est lui qui bouge.')
    print(' */')
    print(f'export const SNACK_MOUTH_TOP: Point[] = [\n  {pts(top)}\n]')
    print(f'export const SNACK_MOUTH_BOTTOM: Point[] = [\n  {pts(bottom)}\n]')
    print()
    print('/**')
    print(' * Machoire grande ouverte : elle tombe de `drop` et pivote de `tilt` degres (sens')
    print(' * horaire a l\'ecran) autour de `pivot`. Une ouverture partielle `f` applique `f` aux')
    print(' * deux, et les silhouettes ci-dessous sont relevees a ces fractions.')
    print(' */')
    print('export const SNACK_JAW = {')
    print(f'  pivot: {{ x: {f((pivot[0] - cx) / px)}, y: {f((pivot[1] - cy) / px)} }},')
    print(f'  drop: {f(JAW_DROP / px)},')
    print(f'  tilt: {JAW_TILT}')
    print('}')
    print()
    print('/** Silhouettes pleines, machoire ouverte a `open` (0 = `SNACK_OUTLINE`). */')
    print('export const SNACK_OUTLINE_OPEN: Array<{ open: number; outline: Point[] }> = [')
    for fr, o in zip(JAW_STEPS, open_outlines):
        print(f'  {{\n    open: {fr:.4f},\n    outline: [\n      {pts(o).replace(chr(10) + "  ", chr(10) + "      ")}\n    ]\n  }},')
    print(']')
    print()
    print('/** Yeux du logo, de gauche a droite. `w`/`h` = diametres, `tilt` en degres. */')
    print('export const SNACK_EYES = [')
    for e in eyes:
        print(
            f"  {{ x: {f(e['x'])}, y: {f(e['y'])}, w: {f(e['w'])}, h: {f(e['h'])}, tilt: {e['tilt']:.1f} }},"
        )
    print('] as const')


if __name__ == '__main__':
    main()
