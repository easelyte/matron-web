/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The redesign-v6 icon set (docs/design/redesign-v6/src/render.js → ICONS): 24-unit strokes in
 * currentColor, rendered at 16px unless a class sizes them.
 */

import React from "react";

type Shape = { c?: [number, number, number][]; p?: string[]; dots?: boolean };

const SHAPES = {
    check: { p: ["M5 12.5l4.5 4.5L19 7.5"] },
    chev: { p: ["M6 9l6 6 6-6"] },
    chevR: { p: ["M9 6l6 6-6 6"] },
    chevL: { p: ["M15 6l-6 6 6 6"] },
    file: { p: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"] },
    search: { c: [[11, 11, 6]], p: ["M20 20l-4.5-4.5"] },
    pencil: { p: ["M4 20h4L19 9l-4-4L4 16z", "M14 6l4 4"] },
    flask: { p: ["M9 3h6", "M10 3v6L5 18a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3L14 9V3", "M7.5 14h9"] },
    shield: { p: ["M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z", "M9 12l2 2 4-4"] },
    history: { c: [[12, 12, 8]], p: ["M12 8v4l3 2"] },
    branch: {
        c: [
            [6, 6, 2],
            [6, 18, 2],
            [18, 8, 2],
        ],
        p: ["M6 8v8", "M18 10a6 6 0 0 1-6 6H8"],
    },
    helper: { c: [[12, 8, 3.5]], p: ["M5 20c1-4 4-6 7-6s6 2 7 6"] },
    globe: { c: [[12, 12, 9]], p: ["M3 12h18", "M12 3c3 3 3 15 0 18c-3-3-3-15 0-18"] },
    terminal: { p: ["M4 5h16v14H4z", "M8 10l3 2-3 2", "M13 15h3"] },
    dot: { c: [[12, 12, 2]] },
    x: { p: ["M6 6l12 12M18 6L6 18"] },
    alert: { c: [[12, 12, 9]], p: ["M12 7.5v5.5", "M12 16.5v.01"] },
    dots: { dots: true },
    gear: {
        c: [[12, 12, 3]],
        p: ["M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"],
    },
    user: { c: [[12, 8, 3.5]], p: ["M5 20c1-4 4-6 7-6s6 2 7 6"] },
    logout: { p: ["M15 4h4v16h-4", "M10 16l-4-4 4-4", "M6 12h10"] },
    plus: { p: ["M12 5v14M5 12h14"] },
    chat: { p: ["M5 5h14v10H9l-4 4z"] },
    memory: { p: ["M6 6h12v12H6z", "M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"] },
} satisfies Record<string, Shape>;

export type V6IconName = keyof typeof SHAPES;

export function V6Icon({ name, className }: { name: V6IconName; className?: string }): React.ReactElement {
    const shape: Shape = SHAPES[name];
    return (
        <svg
            className={`mj_V6Icon mj_V6Icon_${name}${className ? ` ${className}` : ""}`}
            viewBox="0 0 24 24"
            aria-hidden="true"
        >
            {shape.dots ? (
                <>
                    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
                    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
                    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
                </>
            ) : null}
            {shape.c?.map(([cx, cy, r]) => (
                <circle key={`${cx}-${cy}-${r}`} cx={cx} cy={cy} r={r} />
            ))}
            {shape.p?.map((d) => (
                <path key={d} d={d} />
            ))}
        </svg>
    );
}
