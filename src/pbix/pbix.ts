/**
 * Extração (somente leitura) do código M de arquivos .pbix.
 *
 * Formato: o .pbix é um zip; a parte "DataMashup" contém, após um cabeçalho de
 * 8 bytes (int32 versão + int32 tamanho), um segundo zip ("package parts") com
 * Formulas/Section1.m — o documento de section com todas as queries.
 *
 * PBIX salvos com "enhanced metadata" sem DataMashup não são suportados —
 * nesses casos o caminho é salvar como .pbip (TMDL) e usar a extração PBIP.
 */
import AdmZip from "adm-zip";
import * as vscode from "vscode";

import { logInfo } from "../log";

type PbixErrorCode = "open" | "noDataMashup" | "corrupt" | "noFormulas";

export class PbixError extends Error {
    constructor(readonly code: PbixErrorCode, message: string) {
        super(message);
    }
}

function describe(error: PbixError): string {
    switch (error.code) {
        case "open":
            return vscode.l10n.t("M Lens: could not open the file. Is it a valid .pbix?");
        case "noDataMashup":
            return vscode.l10n.t("M Lens: this .pbix stores its queries in the newer format, which cannot be read directly. Save it as a Power BI Project (.pbip) to edit its queries.");
        case "corrupt":
            return vscode.l10n.t("M Lens: the queries inside this .pbix look damaged and could not be read.");
        case "noFormulas":
            return vscode.l10n.t("M Lens: no queries were found inside this .pbix.");
    }
}

export async function extractPbixQueries(uri?: vscode.Uri): Promise<void> {
    let target: vscode.Uri | undefined = uri;

    if (target === undefined) {
        const picked: vscode.Uri[] | undefined = await vscode.window.showOpenDialog({
            filters: { "Power BI": ["pbix", "pbit"] },
            canSelectMany: false,
            title: vscode.l10n.t("Select a .pbix file"),
        });

        target = picked?.[0];
    }

    if (target === undefined) {
        return;
    }

    let section: string;

    try {
        section = readSectionDocument(target.fsPath);
    } catch (error) {
        const message: string = error instanceof Error ? error.message : String(error);

        logInfo(`PBIX: could not read ${target.fsPath}: ${message}`);

        if (error instanceof PbixError && error.code === "noDataMashup") {
            const howTo: string = vscode.l10n.t("How to Convert");

            const choice: string | undefined = await vscode.window.showWarningMessage(
                describe(error),
                {
                    modal: true,
                    detail: vscode.l10n.t(
                        "1. Open the .pbix in Power BI Desktop.\n2. File > Save as > Power BI Project (.pbip).\n3. Open the project folder in VS Code.\n4. Run M Lens: Extract Queries from PBIP.",
                    ),
                },
                howTo,
            );

            if (choice === howTo) {
                await vscode.env.openExternal(
                    vscode.Uri.parse("https://learn.microsoft.com/power-bi/developer/projects/projects-overview"),
                );
            }

            return;
        }

        void vscode.window.showErrorMessage(error instanceof PbixError ? describe(error) : `M Lens: ${message}`);

        return;
    }

    const doc: vscode.TextDocument = await vscode.workspace.openTextDocument({
        language: "powerquery",
        content: section,
    });

    await vscode.window.showTextDocument(doc, { preview: false });

    void vscode.window.showInformationMessage(
        vscode.l10n.t("M Lens: read-only copy of the queries. Changes here do not go back to the .pbix; use a .pbip project to edit and write back."),
    );
}

export function readSectionDocument(pbixPath: string): string {
    let outerZip: AdmZip;

    try {
        outerZip = new AdmZip(pbixPath);
    } catch {
        throw new PbixError("open", "could not open the file as a zip");
    }

    const dataMashupEntry = outerZip.getEntry("DataMashup");

    if (dataMashupEntry === null) {
        throw new PbixError("noDataMashup", "no DataMashup part (enhanced metadata format)");
    }

    const raw: Buffer = dataMashupEntry.getData();

    if (raw.length < 8) {
        throw new PbixError("corrupt", "DataMashup part too short");
    }

    const packageLength: number = raw.readInt32LE(4);

    if (packageLength <= 0 || 8 + packageLength > raw.length) {
        throw new PbixError("corrupt", "invalid DataMashup package length");
    }

    const packageBytes: Buffer = raw.subarray(8, 8 + packageLength);

    let innerZip: AdmZip;

    try {
        innerZip = new AdmZip(packageBytes);
    } catch {
        throw new PbixError("corrupt", "could not read the DataMashup package");
    }

    const formulaEntry =
        innerZip.getEntry("Formulas/Section1.m") ??
        innerZip
            .getEntries()
            .find((e) => e.entryName.startsWith("Formulas/") && e.entryName.endsWith(".m")) ??
        null;

    if (formulaEntry === null) {
        throw new PbixError("noFormulas", "no formula file inside DataMashup");
    }

    return formulaEntry.getData().toString("utf8");
}
