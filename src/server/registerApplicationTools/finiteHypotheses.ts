import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";

import { assessFiniteHypotheses } from "../../application/FiniteHypothesisService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("discriminate_finite_hypotheses");

/** Register finite hypothesis selection and reassessment without execution. */
export const registerFiniteHypothesisTool = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () => Promise.resolve(assessFiniteHypotheses(input)),
          );
          return server.delivery.toCallToolResult(result, contract);
        },
      ),
  );
};
