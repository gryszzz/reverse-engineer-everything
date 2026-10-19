import { registerFiniteHypothesisTool } from "./registerApplicationTools/finiteHypotheses.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import { registerTraceFeatureTool } from "./registerApplicationTools/traceFeature.js";
import { registerTraceJavaScriptSemanticsTool } from "./registerApplicationTools/traceSemantics.js";
import { registerCompareApplicationVersionsTool } from "./registerApplicationTools/compareVersions.js";
import { registerCompareSourceToBundleTool } from "./registerApplicationTools/compareSourceToBundle.js";
import { registerCompareJavaScriptExportShapesTool } from "./registerApplicationTools/compareExportShapes.js";
import { registerCoverageTools } from "./registerApplicationTools/coverage.js";
import { registerReconstructionObligationLedgerTool } from "./registerApplicationTools/obligationLedger.js";
import { registerReconstructionSpecificationTool } from "./registerApplicationTools/deriveReconstructionSpecification.js";
import { registerProjectMobileApplicationGraphTools } from "./registerApplicationTools/projectMobileApplicationGraph.js";
import type { ApplicationToolRegistration } from "./registerApplicationTools/types.js";

/** Register provider-neutral application and reconstruction Evidence workflows. */
export const registerApplicationTools = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  registerTraceFeatureTool(server, options);
  registerTraceJavaScriptSemanticsTool(server, options);
  registerCompareApplicationVersionsTool(server, options);
  registerCompareSourceToBundleTool(server, options);
  registerCompareJavaScriptExportShapesTool(server, options);
  registerReconstructionObligationLedgerTool(server, options);
  registerReconstructionSpecificationTool(server, options);
  registerCoverageTools(server, options);
  registerFiniteHypothesisTool(server, options);
  registerProjectMobileApplicationGraphTools(server, options);
};
