/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { installPushHandlers, type ServiceWorkerScopeLike } from "./push-sw";

installPushHandlers(self as unknown as ServiceWorkerScopeLike);
