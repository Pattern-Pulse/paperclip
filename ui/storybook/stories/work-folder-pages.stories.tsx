import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Layout } from "@/components/Layout";
import { IssueDetail } from "@/pages/IssueDetail";
import { AgentDetail } from "@/pages/AgentDetail";
import { ProjectDetail } from "@/pages/ProjectDetail";
import { ProfileSettings } from "@/pages/ProfileSettings";
import { useCompany } from "@/context/CompanyContext";
import {
  WorkFolderStoryProvider,
  workFolderAgent,
  workFolderProject,
  workFolderTask,
} from "../fixtures/WorkFolderStoryProvider";
import {
  WORK_FOLDER_COMPANY,
  workFolderLabels,
  type WorkFolderScenario,
} from "../fixtures/workFolders";
import type { WorkFolderScope } from "@paperclipai/shared";

const paths = {
  task: `/PAP/issues/${workFolderTask.identifier}`,
  agent: `/PAP/agents/${workFolderAgent.urlKey}`,
  project: `/PAP/projects/${workFolderProject.urlKey}`,
  user: "/PAP/company/settings/instance/profile",
};
function Page({ scope }: { scope: WorkFolderScope }) {
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const onRoute = location.pathname.startsWith(paths[scope]);
  useEffect(() => {
    if (selectedCompanyId !== WORK_FOLDER_COMPANY)
      setSelectedCompanyId(WORK_FOLDER_COMPANY);
  }, [selectedCompanyId, setSelectedCompanyId]);
  useEffect(() => {
    if (!onRoute) navigate(paths[scope], { replace: true });
  }, [scope, onRoute, navigate]);
  if (selectedCompanyId !== WORK_FOLDER_COMPANY || !onRoute) return null;
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="issues/:issueId" element={<IssueDetail />} />
          <Route path="agents/:agentId/:tab?" element={<AgentDetail />} />
          <Route path="projects/:projectId/:tab?" element={<ProjectDetail />} />
          <Route
            path="company/settings/instance/profile"
            element={<ProfileSettings />}
          />
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}
const meta = {
  title: "Work folders/Pages",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Real production pages inside the application Layout, including sidebar, breadcrumb, and original file-button placement. These are current designs, not redesigned mockups. Task files are in the task thread, Agent files and Project files are in their detail pages, and My files is at the bottom of Profile settings. The Open stories click the actual entry point. Work-folder actions use disposable in-memory data; other page edits are not simulated.",
      },
    },
  },
  args: { scope: "task", scenario: "saved" },
  argTypes: {
    scope: { control: false },
    scenario: {
      control: "select",
      options: ["saved", "saving", "failed", "empty", "unavailable"],
    },
  },
  render: ({
    scope,
    scenario,
  }: {
    scope: WorkFolderScope;
    scenario: WorkFolderScenario;
  }) => (
    <WorkFolderStoryProvider key={`${scope}:${scenario}`} scenario={scenario}>
      <Page scope={scope} />
    </WorkFolderStoryProvider>
  ),
} satisfies Meta<{ scope: WorkFolderScope; scenario: WorkFolderScenario }>;
export default meta;
type Story = StoryObj<typeof meta>;
const openFiles: NonNullable<Story["play"]> = async ({
  canvasElement,
  args,
}) => {
  const label = workFolderLabels[args.scope];
  await userEvent.click(
    await within(canvasElement).findByRole(
      "button",
      { name: label },
      { timeout: 15000 },
    ),
  );
  await expect(
    await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: label,
    }),
  ).toBeVisible();
};
export const TaskPage: Story = { args: { scope: "task" } };
export const TaskFilesOpen: Story = {
  args: { scope: "task" },
  play: openFiles,
};
export const AgentPage: Story = { args: { scope: "agent" } };
export const AgentFilesOpen: Story = {
  args: { scope: "agent" },
  play: openFiles,
};
export const ProjectPage: Story = { args: { scope: "project" } };
export const ProjectFilesOpen: Story = {
  args: { scope: "project" },
  play: openFiles,
};
export const ProfileSettingsPage: Story = { args: { scope: "user" } };
export const MyFilesOpen: Story = { args: { scope: "user" }, play: openFiles };
export const TaskSaveFailed: Story = {
  args: { scope: "task", scenario: "failed" },
  play: openFiles,
};
export const ProjectEmptyFolder: Story = {
  args: { scope: "project", scenario: "empty" },
  play: openFiles,
};
export const MobileTaskFilesOpen: Story = {
  args: { scope: "task" },
  globals: { viewport: { value: "mobile" } },
  play: openFiles,
};
