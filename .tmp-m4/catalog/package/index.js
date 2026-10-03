/** The dsh plugin catalog, as published by dsh-plugin-shop. */

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const indexPath = join(__dirname, 'v1', 'index.json')
const pluginsPath = join(__dirname, 'v1', "plugins.2735b62a32078730aed5d438397b4baed256b4abd40c84aeb2633fb776571831.json")
const starsPath = join(__dirname, 'v1', "stars.50dad6f91319137b3ece015d841ea6c2ca232b798176ebea933f1052ae5cfd4f.json")

/** The pointer: schemaVersion, builtAt, count, and the data file's sha256. */
function readIndex() {
  return JSON.parse(readFileSync(indexPath, 'utf8'))
}

/** The catalog itself: { schemaVersion, plugins, denied }. */
function readPlugins() {
  return JSON.parse(readFileSync(pluginsPath, 'utf8'))
}

/** GitHub star counts by package name, or null when this build published none. */
function readStars() {
  return starsPath === null ? null : JSON.parse(readFileSync(starsPath, 'utf8'))
}

module.exports = { indexPath, pluginsPath, starsPath, readIndex, readPlugins, readStars }
