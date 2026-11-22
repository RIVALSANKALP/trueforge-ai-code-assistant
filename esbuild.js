const esbuild = require("esbuild");

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: {
      extension: "src/extension.ts",
      smokeTestRunner: "src/test/smokeTestRunner.ts",
      inlineEditTest: "src/test/inlineEditTest.ts",
      autonomousAgentTest: "src/test/autonomousAgentTest.ts",
      turnResponseTest: "src/test/turnResponseTest.ts",
      mcpServerTest: "src/test/mcpServerTest.ts"
    },
    bundle: true,
    format: "cjs",
    minify: isProduction,
    sourcemap: !isProduction,
    sourcesContent: false,
    platform: "node",
    outdir: "dist",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [
      {
        name: "esbuild-problem-matcher",
        setup(build) {
          build.onStart(() => {
            console.log("[watch] build started");
          });
          build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
              console.error(`✘ [ERROR] ${text}`);
              if (location) {
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
              }
            });
            console.log("[watch] build finished");
          });
        },
      },
    ],
  });

  if (isWatch) {
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
