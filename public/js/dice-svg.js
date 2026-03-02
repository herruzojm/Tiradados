window.DiceSVG = {
  types: ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'],

  render(type, size) {
    size = size || 64;
    const fn = this._shapes[type];
    return fn ? fn(size) : '';
  },

  _shapes: {
    // d4: triangle (tetrahedron face)
    d4(s) {
      return `<svg viewBox="0 0 64 64" width="${s}" height="${s}">
        <polygon points="32,6 4,58 60,58" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
        <text x="32" y="46" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor" font-family="system-ui">d4</text>
      </svg>`;
    },

    // d6: rounded square (cube face)
    d6(s) {
      return `<svg viewBox="0 0 64 64" width="${s}" height="${s}">
        <rect x="8" y="8" width="48" height="48" rx="7" fill="none" stroke="currentColor" stroke-width="2.5"/>
        <text x="32" y="38" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor" font-family="system-ui">d6</text>
      </svg>`;
    },

    // d8: diamond (octahedron face)
    d8(s) {
      return `<svg viewBox="0 0 64 64" width="${s}" height="${s}">
        <polygon points="32,4 60,32 32,60 4,32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
        <text x="32" y="38" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor" font-family="system-ui">d8</text>
      </svg>`;
    },

    // d10: kite / irregular pentagon
    d10(s) {
      return `<svg viewBox="0 0 64 64" width="${s}" height="${s}">
        <polygon points="32,4 58,26 50,60 14,60 6,26" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
        <text x="32" y="42" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor" font-family="system-ui">d10</text>
      </svg>`;
    },

    // d12: regular pentagon (dodecahedron face)
    d12(s) {
      const cx = 32, cy = 34, r = 27;
      const pts = [];
      for (let i = 0; i < 5; i++) {
        const a = (i * 72 - 90) * Math.PI / 180;
        pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
      }
      return `<svg viewBox="0 0 64 64" width="${s}" height="${s}">
        <polygon points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
        <text x="32" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor" font-family="system-ui">d12</text>
      </svg>`;
    },

    // d20: hexagon (icosahedron silhouette)
    d20(s) {
      const cx = 32, cy = 32, r = 28;
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = (i * 60 - 90) * Math.PI / 180;
        pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
      }
      return `<svg viewBox="0 0 64 64" width="${s}" height="${s}">
        <polygon points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
        <text x="32" y="38" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="system-ui">d20</text>
      </svg>`;
    },

    // d100: circle with %
    d100(s) {
      return `<svg viewBox="0 0 64 64" width="${s}" height="${s}">
        <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" stroke-width="2.5"/>
        <text x="32" y="37" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor" font-family="system-ui">d100</text>
      </svg>`;
    },
  }
};
