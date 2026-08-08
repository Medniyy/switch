import { expect, test } from "@playwright/test";
import { BananaCatchGame } from "../lib/bananaCatch";

interface TestFaller {
  x: number;
  y: number;
  size: number;
  popped: number | null;
}

const fallersOf = (game: BananaCatchGame) =>
  (game as unknown as { fallers: TestFaller[] }).fallers;

const advance = (game: BananaCatchGame, ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    game.update(Math.min(50, ms - elapsed), 400, 700, []);
  }
};

test("a catch needs stable contact and the banana is then removed", () => {
  const game = new BananaCatchGame();
  game.reset();

  // Finish the intro. Its transition creates the first target immediately.
  advance(game, 2_000);
  const target = fallersOf(game)[0];
  expect(target).toBeTruthy();

  const hand = { x: target.x, y: target.y, r: target.size * 0.25 };
  game.update(35, 400, 700, [hand]);
  expect(game.score).toBe(0); // one tracking frame cannot score by itself
  game.update(35, 400, 700, [hand]);
  expect(game.score).toBeGreaterThan(0);
  expect(fallersOf(game)[0]?.popped).not.toBeNull();

  // The old filter could never delete a catch after popped reached exactly 0.
  advance(game, 200);
  expect(fallersOf(game)).toHaveLength(0);
});

test("a one-frame false hand does not produce a random score", () => {
  const game = new BananaCatchGame();
  advance(game, 2_000);
  const target = fallersOf(game)[0];

  game.update(40, 400, 700, [{ x: target.x, y: target.y, r: target.size }]);
  game.update(40, 400, 700, []);
  expect(game.score).toBe(0);
});
