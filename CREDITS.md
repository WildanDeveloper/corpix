# Credits

## Code

Corpix is an independent project inspired by the projects listed in the target
design (`docs/DESIGN.md`).

## Art

**No third-party art is bundled.** Every character, desk, prop and tile in the
office is drawn programmatically at runtime:

- `apps/web/src/office/sprites.ts` generates 12x16 character frames into an RGBA
  buffer, with a palette per role.
- `apps/web/src/office/scene.ts` draws floors, walls, desks, plants, racks and the
  coffee machine with PixiJS `Graphics`.

That keeps the repository free of licensed assets and makes recolouring a role a
one-line change. If you replace the generated art with a spritesheet, record the
pack name, source URL and licence here.
