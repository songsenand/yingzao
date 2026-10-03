# dsh-plugin-shop-catalog

The plugin catalog published by [dsh-plugin-shop](https://github.com/LivXue/dsh-plugin-shop),
packaged so it can be read from an npm registry as well as from the web.

- Build: `2026-09-24T06:04:03.376Z`
- Listed plugins: 12005

The same bytes are served at
<https://LivXue.github.io/dsh-plugin-shop/v1/>. This package exists so a
reader whose link to GitHub is slow can take the catalog from a nearby npm
mirror instead; the shop races both and uses whichever answers first.

```js
const catalog = require('dsh-plugin-shop-catalog')

catalog.readIndex()    // { schemaVersion, builtAt, count, plugins: { url, sha256 }, ... }
catalog.readPlugins()  // { schemaVersion, plugins: [...], denied: [...] }
catalog.readStars()    // { stars: { "<name|owner/repo>": <count> } } or null
```

`readIndex().plugins.sha256` is the sha256 of the file `readPlugins()`
parses; verifying it is how the shop binds the pointer to the data, and any
consumer can do the same.

Versions are `YYYY.MMDD.N`. Published from CI on each catalog build; a
version is never republished.
