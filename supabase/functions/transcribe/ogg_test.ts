import { oggOpusSeconds } from "./ogg.ts";
const dir = Deno.args[0];
for (const [f, expected] of [["chk000.ogg", 600], ["chk002.ogg", 250], ["../spikeweb/out_out.ogg", 475.6]] as const) {
  const s = oggOpusSeconds(await Deno.readFile(`${dir}/${f}`));
  if (s == null || Math.abs(s - expected) > 1) throw new Error(`${f}: ${s} != ${expected}`);
  console.log("ok", f, s.toFixed(2));
}
if (oggOpusSeconds(new TextEncoder().encode("not an ogg file at all, just some text bytes here........................")) !== null) throw new Error("accepted garbage");
console.log("ok garbage rejected");
