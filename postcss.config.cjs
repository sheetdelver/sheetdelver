const path = require('path');

module.exports = {
  plugins: {
    [path.join(process.cwd(), '.managed/postcss-plugin.cjs')]: {},
    '@tailwindcss/postcss': {},
  },
};
