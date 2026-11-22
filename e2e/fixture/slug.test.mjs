import test from "node:test"
import assert from "node:assert/strict"
import { slug } from "./slug.mjs"

test("joins words with hyphens", () => {
  assert.equal(slug("Hello World"), "hello-world")
})

test("joins words with underscores for file names", () => {
  assert.equal(slug("Hello World"), "hello_world")
})

test("trims", () => {
  assert.equal(slug("  Hi  "), "hi")
})
