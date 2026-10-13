import { Argument, Command, Option } from "commander";
import { basename } from "node:path";

import { ApiExecutor, type ExecuteOptions } from "./api.ts";
import { SharedCache } from "./cache.ts";
import { complete, completionScript, type Shell } from "./completion.ts";
import { getSwaggerUrl, loadConfig } from "./config.ts";
import { parseDuration } from "./duration.ts";
import { Doctor, formatDoctor } from "./doctor.ts";
import { collect, parseFields } from "./fields.ts";
import { readInput } from "./input.ts";
import { Notes } from "./notes.ts";
import { writeApiResult, writeError, writeVerbose } from "./output.ts";
import { PublicMarkdownReader, type ApiPolicy } from "./public-markdown.ts";
import {
  findOperation,
  formatOperationTable,
  formatSpecSummary,
  listOperations,
  SpecStore,
} from "./spec.ts";

const VERSION = "0.1.2";

interface RequestFlags {
  cache: string;
  field: string[];
  fresh?: boolean;
  header: string[];
  input?: string;
  offline?: boolean;
  rawField: string[];
  verbose?: boolean;
}

interface ReadFlags {
  team?: string;
  api: ApiPolicy;
  cache: string;
  fresh?: boolean;
  offline?: boolean;
  verbose?: boolean;
}

interface ContentFlags {
  content?: string;
  file?: string;
}

function addRequestOptions(command: Command): Command {
  return command
    .option("-F, --field <key=value>", "typed field; repeatable", collect, [])
    .option("-f, --raw-field <key=value>", "string field; repeatable", collect, [])
    .option("-H, --header <name:value>", "request header; repeatable", collect, [])
    .option("--input <file>", "request body file, or - for stdin")
    .option("--cache <duration>", "successful GET cache duration", "5m")
    .option("--fresh", "ignore a fresh cached response")
    .option("--offline", "never make a network request")
    .option("--verbose", "write transport and cache details to stderr");
}

async function executeOptions(flags: RequestFlags): Promise<ExecuteOptions> {
  return {
    cacheMs: parseDuration(flags.cache),
    fields: await parseFields(flags.field, flags.rawField),
    headers: flags.header,
    ...(flags.fresh === undefined ? {} : { fresh: flags.fresh }),
    ...(flags.input ? { input: await readInput(flags.input) } : {}),
    ...(flags.offline === undefined ? {} : { offline: flags.offline }),
  };
}

async function optionalContent(flags: ContentFlags): Promise<string | undefined> {
  if (flags.content !== undefined) return flags.content;
  if (flags.file) return Buffer.from(await readInput(flags.file)).toString("utf8");
  if (!process.stdin.isTTY) {
    const input = Buffer.from(await readInput("-")).toString("utf8");
    if (input.length > 0) return input;
  }
  return undefined;
}

function addContentOptions(command: Command): Command {
  return command
    .addOption(new Option("--content <markdown>", "inline Markdown").conflicts("file"))
    .addOption(
      new Option("--file <file>", "read Markdown from a file, or - for stdin").conflicts("content"),
    );
}

function addNoteReadOptions(command: Command): Command {
  return command
    .option("--team <path>", "use this team API workspace")
    .addOption(
      new Option("--api <policy>", "API fallback policy")
        .choices(["always", "auto", "never"])
        .default("auto"),
    )
    .option("--cache <duration>", "cache duration", "5m")
    .option("--fresh", "revalidate even when the cache is fresh")
    .option("--offline", "never make a network request")
    .option("--verbose", "write transport and cache details to stderr");
}

async function main(argv: string[]): Promise<void> {
  const config = loadConfig();
  const cache = new SharedCache(config.cacheDir);
  const specs = new SpecStore(config, cache);
  const api = new ApiExecutor(config, cache, specs);
  const markdown = new PublicMarkdownReader(config, cache, api);
  const notes = new Notes(config, api, markdown);
  const doctor = new Doctor(VERSION, config, cache, api);
  const jsonErrors = argv.includes("--json-errors");
  const writeResult = (result: Parameters<typeof writeApiResult>[0]) =>
    writeApiResult(result, { jsonErrors });

  if (argv[0] === "__complete") {
    let document;
    try {
      document = await specs.load();
    } catch {}
    process.stdout.write(`${complete(argv.slice(1), document).join("\n")}\n`);
    return;
  }

  let apiHelp = `\nActive Swagger: ${getSwaggerUrl(config)}`;
  if (argv[0] === "api" && (argv[1] === "--help" || argv[1] === "-h" || argv.length === 1)) {
    try {
      apiHelp = formatSpecSummary(await specs.load(), getSwaggerUrl(config));
    } catch (error) {
      apiHelp += `\nOperations unavailable: ${(error as Error).message}`;
    }
  }

  const program = new Command()
    .name("hmd")
    .description("Dynamic, agent-friendly HackMD CLI")
    .version(VERSION)
    .option("--json-errors", "emit structured command errors as JSON")
    .showHelpAfterError()
    .addHelpCommand(true);

  const apiCommand = program
    .command("api")
    .description("Inspect and call the current HackMD OpenAPI surface")
    .addHelpText("after", apiHelp)
    .action(function () {
      this.outputHelp();
    });

  apiCommand
    .command("operations")
    .description("List operations from the active Swagger document")
    .option("--json", "emit JSON")
    .action(async (flags: { json?: boolean }) => {
      const document = await specs.load();
      const operations = listOperations(document).map(({ method, operation, path }) => ({
        description: operation.description || "",
        method,
        operationId: operation.operationId,
        path,
        tags: operation.tags || [],
      }));
      if (flags.json) console.log(JSON.stringify(operations, null, 2));
      else console.log(formatOperationTable(document));
    });

  apiCommand
    .command("describe")
    .description("Describe one operation as JSON")
    .argument("<operation-id>")
    .action(async (operationId: string) => {
      const document = await specs.load();
      const operation = findOperation(document, operationId);
      if (!operation) throw new Error(`Unknown operationId "${operationId}".`);
      console.log(JSON.stringify(operation, null, 2));
    });

  addRequestOptions(
    apiCommand
      .command("call")
      .description("Call an operation by its dynamic OpenAPI operationId")
      .argument("<operation-id>"),
  ).action(async (operationId: string, flags: RequestFlags) => {
    const result = await api.call(operationId, await executeOptions(flags));
    writeResult(result);
    writeVerbose(flags.verbose, result);
  });

  addRequestOptions(
    apiCommand
      .command("request")
      .description("Make a raw request relative to HMD_API_URL")
      .argument("<method>")
      .argument("<path>"),
  ).action(async (method: string, path: string, flags: RequestFlags) => {
    const result = await api.request(method, path, await executeOptions(flags));
    writeResult(result);
    writeVerbose(flags.verbose, result);
  });

  const noteCommand = program
    .command("note")
    .description("Work with notes through cache-aware, public-first commands")
    .action(function () {
      this.outputHelp();
    });

  noteCommand
    .command("list")
    .alias("ls")
    .description("List personal notes, or notes in one explicit team")
    .option("--team <path>", "list notes in this team path")
    .option("--cache <duration>", "cache duration", "5m")
    .option("--fresh", "ignore a fresh cached response")
    .option("--offline", "never make a network request")
    .option("--verbose", "write transport and cache details to stderr")
    .action(
      async (flags: {
        cache: string;
        fresh?: boolean;
        offline?: boolean;
        team?: string;
        verbose?: boolean;
      }) => {
        const result = await notes.list({
          cacheMs: parseDuration(flags.cache),
          ...(flags.fresh === undefined ? {} : { fresh: flags.fresh }),
          ...(flags.offline === undefined ? {} : { offline: flags.offline }),
          ...(flags.team === undefined ? {} : { team: flags.team }),
        });
        writeResult(result);
        writeVerbose(flags.verbose, result);
      },
    );

  addNoteReadOptions(
    noteCommand
      .command("view")
      .description("Print normalized note JSON using public Markdown before the API")
      .argument("<note-or-url>"),
  ).action(async (reference: string, flags: ReadFlags) => {
    const result = await notes.view(reference, {
      api: flags.api,
      ...(flags.team === undefined ? {} : { team: flags.team }),
      cacheMs: parseDuration(flags.cache),
      ...(flags.fresh === undefined ? {} : { fresh: flags.fresh }),
      ...(flags.offline === undefined ? {} : { offline: flags.offline }),
    });
    writeResult(result);
    writeVerbose(flags.verbose, result);
  });

  addNoteReadOptions(
    noteCommand
      .command("cat")
      .description("Print note Markdown; cache and public web are tried before the API")
      .argument("<note-or-url>")
      .option("--meta", "include HackMD-generated title and tags front matter"),
  ).action(
    async (
      reference: string,
      flags: {
        api: ApiPolicy;
        cache: string;
        fresh?: boolean;
        meta?: boolean;
        team?: string;
        offline?: boolean;
        verbose?: boolean;
      },
    ) => {
      const result = await markdown.read(reference, {
        api: flags.api,
        ...(flags.team === undefined ? {} : { team: flags.team }),
        cacheMs: parseDuration(flags.cache),
        ...(flags.fresh === undefined ? {} : { fresh: flags.fresh }),
        ...(flags.meta === undefined ? {} : { meta: flags.meta }),
        ...(flags.offline === undefined ? {} : { offline: flags.offline }),
      });
      process.stdout.write(result.body);
      if (result.body.length > 0 && result.body.at(-1) !== 10) process.stdout.write("\n");
      writeVerbose(flags.verbose, result);
    },
  );

  addContentOptions(
    noteCommand
      .command("create")
      .description("Create a personal or team note from Markdown")
      .option("--team <path>", "create the note in this team path")
      .option("--title <title>", "note title")
      .option("--read-permission <permission>", "note read permission")
      .option("--write-permission <permission>", "note write permission")
      .option("--verbose", "write transport details to stderr"),
  ).action(
    async (
      flags: ContentFlags & {
        readPermission?: string;
        team?: string;
        title?: string;
        verbose?: boolean;
        writePermission?: string;
      },
    ) => {
      const content = await optionalContent(flags);
      const result = await notes.create({
        ...(content === undefined ? {} : { content }),
        ...(flags.readPermission === undefined ? {} : { readPermission: flags.readPermission }),
        ...(flags.team === undefined ? {} : { team: flags.team }),
        ...(flags.title === undefined ? {} : { title: flags.title }),
        ...(flags.writePermission === undefined ? {} : { writePermission: flags.writePermission }),
      });
      writeResult(result);
      writeVerbose(flags.verbose, result);
    },
  );

  addContentOptions(
    noteCommand
      .command("update")
      .alias("edit")
      .description("Update a note; unchanged public content does not issue a PATCH")
      .argument("<note-or-url>")
      .option("--team <path>", "use this team API workspace")
      .option("--title <title>", "note title")
      .option("--description <description>", "note description")
      .option("--tag <tag>", "replace note tags; repeatable", collect, [])
      .option("--read-permission <permission>", "note read permission")
      .option("--write-permission <permission>", "note write permission")
      .option("--permalink <permalink>", "note permalink")
      .option("--parent-folder <id>", "move the note to this folder")
      .option("--force", "write content without checking the public representation")
      .option("--cache <duration>", "cache duration for the no-op check", "5m")
      .option("--verbose", "write transport details to stderr"),
  ).action(
    async (
      reference: string,
      flags: ContentFlags & {
        cache: string;
        team?: string;
        description?: string;
        force?: boolean;
        parentFolder?: string;
        permalink?: string;
        readPermission?: string;
        tag: string[];
        title?: string;
        verbose?: boolean;
        writePermission?: string;
      },
    ) => {
      const content = await optionalContent(flags);
      const result = await notes.update(reference, {
        ...(flags.team === undefined ? {} : { team: flags.team }),
        cacheMs: parseDuration(flags.cache),
        ...(content === undefined ? {} : { content }),
        ...(flags.description === undefined ? {} : { description: flags.description }),
        ...(flags.force === undefined ? {} : { force: flags.force }),
        ...(flags.parentFolder === undefined ? {} : { parentFolderId: flags.parentFolder }),
        ...(flags.permalink === undefined ? {} : { permalink: flags.permalink }),
        ...(flags.readPermission === undefined ? {} : { readPermission: flags.readPermission }),
        ...(flags.tag.length === 0 ? {} : { tags: flags.tag }),
        ...(flags.title === undefined ? {} : { title: flags.title }),
        ...(flags.writePermission === undefined ? {} : { writePermission: flags.writePermission }),
      });
      writeResult(result);
      writeVerbose(flags.verbose, result);
    },
  );

  addNoteReadOptions(
    noteCommand
      .command("diff")
      .description("Compare remote note Markdown with a file or stdin")
      .argument("<note-or-url>")
      .argument("[file]", "local Markdown file, or - for stdin", "-"),
  ).action(async (reference: string, file: string, flags: ReadFlags) => {
    const localContent = Buffer.from(await readInput(file)).toString("utf8");
    const result = await notes.diff(reference, {
      api: flags.api,
      ...(flags.team === undefined ? {} : { team: flags.team }),
      cacheMs: parseDuration(flags.cache),
      filename: file === "-" ? "stdin" : basename(file),
      ...(flags.fresh === undefined ? {} : { fresh: flags.fresh }),
      localContent,
      ...(flags.offline === undefined ? {} : { offline: flags.offline }),
    });
    writeResult(result);
    writeVerbose(flags.verbose, result);
    if (result.different) process.exitCode = 1;
  });

  noteCommand
    .command("delete")
    .alias("rm")
    .description("Move a personal or accessible team note to trash")
    .argument("<note-or-url>")
    .option("--verbose", "write transport details to stderr")
    .option("--team <path>", "use this team API workspace")
    .action(async (reference: string, flags: { verbose?: boolean; team?: string }) => {
      const result = await notes.delete(
        reference,
        flags.team === undefined ? {} : { team: flags.team },
      );
      writeResult(result);
      writeVerbose(flags.verbose, result);
    });

  noteCommand
    .command("resolve")
    .description("Normalize a note URL or ID without making a network request")
    .argument("<note-or-url>")
    .action((reference: string) => {
      writeResult(notes.resolve(reference));
    });

  const cacheCommand = program
    .command("cache")
    .description("Inspect or clear the shared persistent cache")
    .action(function () {
      this.outputHelp();
    });

  cacheCommand
    .command("status")
    .description("Show cache location, size, entry count, and fetch times")
    .option("--json", "emit JSON")
    .action(async (flags: { json?: boolean }) => {
      const stats = await cache.stats();
      if (flags.json) console.log(JSON.stringify(stats, null, 2));
      else {
        console.log(`Directory: ${stats.root}`);
        console.log(`Entries:   ${stats.entries}`);
        console.log(`Bytes:     ${stats.bytes}`);
        console.log(`Oldest:    ${stats.oldestFetchedAt || "-"}`);
        console.log(`Newest:    ${stats.newestFetchedAt || "-"}`);
      }
    });

  program
    .command("doctor")
    .description("Check endpoints, credentials, and cache writability")
    .option("--json", "emit JSON")
    .action(async (flags: { json?: boolean }) => {
      const result = await doctor.run();
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else process.stdout.write(formatDoctor(result));
      if (!result.ok) process.exitCode = 1;
    });

  cacheCommand
    .command("clear")
    .description("Remove hmd cache entries from the shared cache directory")
    .action(async () => {
      console.log(`Removed ${await cache.clear()} cache entries.`);
    });

  program
    .command("completion")
    .description("Print a shell completion script")
    .addArgument(new Argument("[shell]", "shell name").choices(["bash", "fish", "zsh"]))
    .action((shell?: Shell) => {
      const selected = shell || (process.env.SHELL?.split("/").at(-1) as Shell | undefined);
      if (!selected || !["bash", "fish", "zsh"].includes(selected)) {
        throw new Error("Specify a supported shell: bash, fish, or zsh.");
      }
      process.stdout.write(completionScript(selected));
    });

  await program.parseAsync(argv, { from: "user" });
}

const argv = process.argv.slice(2);
main(argv).catch((error: unknown) => {
  writeError(error, {
    json: argv.includes("--json-errors"),
    verbose: argv.includes("--verbose"),
  });
  process.exitCode = 1;
});
