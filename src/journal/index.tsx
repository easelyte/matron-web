/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/fira-code/latin-400.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";

import { MatronJournalClient } from "./client";
import { MatronApp } from "./components";
import "./shell.pcss";
import "./journal.pcss";

const container = document.getElementById("matron");
if (!container) throw new Error("Matron application container is missing");

const client = new MatronJournalClient();
createRoot(container).render(
    <React.StrictMode>
        <MatronApp client={client} />
    </React.StrictMode>,
);
void client.initialise();
