import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Modal, Pagination, Select, Space, Tag, Typography, message } from "antd";
import { requestJson } from "../lib/apiClient";

const { Text, Title } = Typography;
const { TextArea } = Input;

export default function PersonaDistillWorkbench({ frameKey }) {
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [modelConfig, setModelConfig] = useState({});
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [command, setCommand] = useState("");
  const [depthLevel, setDepthLevel] = useState("commercial");
  const [materialType, setMaterialType] = useState("聊天记录");
  const [uploading, setUploading] = useState(false);
  const [savingDepth, setSavingDepth] = useState(false);
  const [runningProjectId, setRunningProjectId] = useState("");
  const [skillsDir, setSkillsDir] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [projectPage, setProjectPage] = useState(1);
  const [chatProjectId, setChatProjectId] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const fileInputRef = useRef(null);
  const [api, contextHolder] = message.useMessage();
  const depthOptions = [
    { value: "quick", label: "快速 1轮" },
    { value: "standard", label: "标准 3轮" },
    { value: "commercial", label: "商用 5轮" },
  ];

  const loadProjects = async (selectId = activeId) => {
    setLoading(true);
    try {
      const data = await requestJson("/api/persona-distill/projects");
      const nextProjects = data.projects || [];
      setProjects(nextProjects);
      setModelConfig(data.modelConfig || {});
      setSkillsDir(data.skillsDir || "");
      const nextId = selectId || nextProjects[0]?.id || "";
      setActiveId(nextProjects.some((item) => item.id === nextId) ? nextId : nextProjects[0]?.id || "");
      setChatProjectId((current) => {
        if (current && nextProjects.some((item) => item.id === current && item.skillMarkdown)) return current;
        return nextProjects.find((item) => item.skillMarkdown)?.id || "";
      });
    } catch (error) {
      api.error(`加载人物蒸馏项目失败：${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);

  useEffect(() => {
    if (!projects.some((item) => item.status === "distilling")) return undefined;
    const timer = window.setInterval(() => loadProjects(activeId), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activeId]);

  const activeProject = useMemo(
    () => projects.find((item) => item.id === activeId) || projects[0],
    [projects, activeId]
  );
  const completedProjects = useMemo(
    () => projects.filter((item) => item.skillMarkdown || item.status === "completed"),
    [projects]
  );
  const filteredProjects = useMemo(() => {
    const keyword = projectSearch.trim().toLowerCase();
    if (!keyword) return projects;
    return projects.filter((project) =>
      [
        project.name,
        project.title,
        project.prompt,
        project.status,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword))
    );
  }, [projects, projectSearch]);
  const projectPageSize = 8;
  const projectPageTotal = Math.max(1, Math.ceil(filteredProjects.length / projectPageSize));
  const visibleProjects = filteredProjects.slice((projectPage - 1) * projectPageSize, projectPage * projectPageSize);

  useEffect(() => {
    if (projectPage > projectPageTotal) setProjectPage(projectPageTotal);
  }, [projectPage, projectPageTotal]);

  const createProject = async () => {
    if (!command.trim()) {
      api.warning("输入一句话，比如：蒸馏某人的客服沟通风格");
      return;
    }
    setCreating(true);
    try {
      const data = await requestJson("/api/persona-distill/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: command, depthLevel }),
      });
      if (!data.ok) throw new Error(data.error || "创建失败");
      api.success("蒸馏任务已创建");
      setCommand("");
      await loadProjects(data.project.id);
    } catch (error) {
      api.error(error.message);
    } finally {
      setCreating(false);
    }
  };

  const uploadMaterials = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!activeProject || !files.length) return;
    setUploading(true);
    try {
      const materials = await Promise.all(
        files.map(
          (file) =>
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => {
                resolve({
                  type: materialType,
                  name: file.name,
                  size: file.size,
                  contentType: file.type,
                  contentPreview: typeof reader.result === "string" ? reader.result.slice(0, 4000) : "",
                });
              };
              reader.onerror = () => {
                resolve({
                  type: materialType,
                  name: file.name,
                  size: file.size,
                  contentType: file.type,
                  contentPreview: "",
                });
              };
              if (/text|json|markdown|csv|xml|javascript|plain/i.test(file.type || file.name)) {
                reader.readAsText(file);
              } else {
                resolve({
                  type: materialType,
                  name: file.name,
                  size: file.size,
                  contentType: file.type,
                  contentPreview: "",
                });
              }
            })
        )
      );
      const data = await requestJson(`/api/persona-distill/projects/${encodeURIComponent(activeProject.id)}/materials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ materials }),
      });
      if (!data.ok) throw new Error(data.error || "上传失败");
      api.success(`已添加 ${materials.length} 份材料`);
      await loadProjects(activeProject.id);
    } catch (error) {
      api.error(error.message);
    } finally {
      setUploading(false);
    }
  };

  const updateDepth = async (nextDepth) => {
    if (!activeProject) return;
    setSavingDepth(true);
    try {
      const data = await requestJson(`/api/persona-distill/projects/${encodeURIComponent(activeProject.id)}/depth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depthLevel: nextDepth }),
      });
      if (!data.ok) throw new Error(data.error || "保存失败");
      api.success("蒸馏深度已更新");
      await loadProjects(activeProject.id);
    } catch (error) {
      api.error(error.message);
    } finally {
      setSavingDepth(false);
    }
  };

  const deleteProject = async (project) => {
    if (!project) return;
    Modal.confirm({
      title: `删除任务：${project.name}`,
      content: "只会从蒸馏任务列表删除；如果已生成服务器 Skill 文件，暂不物理删除。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        const data = await requestJson(`/api/persona-distill/projects/${encodeURIComponent(project.id)}`, {
          method: "DELETE",
        });
        if (!data.ok) throw new Error(data.error || "删除失败");
        api.success("任务已删除");
        if (activeId === project.id) setActiveId("");
        if (chatProjectId === project.id) {
          setChatProjectId("");
          setChatMessages([]);
        }
        await loadProjects(activeId === project.id ? "" : activeId);
      },
    });
  };

  const runDistill = async () => {
    if (!activeProject) return;
    setRunningProjectId(activeProject.id);
    try {
      const data = await requestJson(`/api/persona-distill/projects/${encodeURIComponent(activeProject.id)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!data.ok) throw new Error(data.error || "蒸馏失败");
      api.success("蒸馏任务已启动，刷新页面也会保留任务状态");
      await loadProjects(data.project?.id || activeProject.id);
    } catch (error) {
      api.error(error.message);
    } finally {
      setRunningProjectId("");
    }
  };

  const sendPersonaChat = async () => {
    const text = chatInput.trim();
    if (!chatProjectId) {
      api.warning("先选择一个已蒸馏完成的人物");
      return;
    }
    if (!text) return;
    const nextMessages = [...chatMessages, { role: "user", content: text }];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatLoading(true);
    try {
      const data = await requestJson("/api/persona-distill/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: chatProjectId, message: text, history: chatMessages }),
      });
      if (!data.ok) throw new Error(data.error || "对话失败");
      setChatMessages([...nextMessages, { role: "assistant", content: data.reply || "" }]);
    } catch (error) {
      api.error(error.message);
      setChatMessages(chatMessages);
    } finally {
      setChatLoading(false);
    }
  };

  const statusLabel = (status) => {
    if (status === "materials_required") return "待上传材料";
    if (status === "materials_ready") return "材料待解析";
    if (status === "research_pending") return "可网络调研";
    if (status === "distilling") return "蒸馏中";
    if (status === "failed") return "蒸馏失败";
    if (status === "completed") return "已完成";
    if (status === "draft") return "草稿";
    return status || "草稿";
  };

  const materialCount = activeProject?.sources?.filter((item) => item.status === "已上传").length || 0;
  const needsMaterials = activeProject?.materialMode === "materials_required" || activeProject?.status === "materials_required";
  const canUsePublicResearch = activeProject?.materialMode === "public_research";
  const currentRound = Math.max(0, Number(activeProject?.currentRound || 0));
  const targetRounds = Math.max(1, Number(activeProject?.targetRounds || 5));
  const distillPercent = Math.min(100, Math.round((currentRound / targetRounds) * 100));
  const selectedChatProject = projects.find((item) => item.id === chatProjectId);

  return (
    <div className="persona-workbench">
      {contextHolder}
      <section className="review-pane">
        <div className="review-toolbar">
          <div>
            <Title level={5}>人物蒸馏项目</Title>
            <Text>输入要蒸馏的人，材料不够时再补材料。</Text>
          </div>
          <Button size="small" onClick={() => loadProjects()} loading={loading}>
            刷新
          </Button>
        </div>
        <div className="persona-project-search">
          <Input
            value={projectSearch}
            onChange={(event) => {
              setProjectSearch(event.target.value);
              setProjectPage(1);
            }}
            allowClear
            placeholder="搜索人物、任务、状态"
          />
          <small>
            {filteredProjects.length} / {projects.length} 个任务
          </small>
        </div>
        <div className="review-list">
          {visibleProjects.map((project) => (
            <button
              className={`review-item ${project.id === activeProject?.id ? "active" : ""}`}
              key={project.id}
              onClick={() => setActiveId(project.id)}
            >
              <span>{project.name}</span>
              <small>{project.title}</small>
              <span className="review-item-foot">
                <em>{statusLabel(project.status)}</em>
                <button
                  className="review-item-delete"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteProject(project);
                  }}
                >
                  删除
                </button>
              </span>
            </button>
          ))}
          {!visibleProjects.length ? <div className="persona-project-empty">没有匹配的任务。</div> : null}
        </div>
        <div className="persona-project-pagination">
          <Pagination
            size="small"
            simple
            current={projectPage}
            pageSize={projectPageSize}
            total={filteredProjects.length}
            onChange={setProjectPage}
          />
        </div>
        <div className="persona-create">
          <Title level={5}>要蒸馏谁</Title>
          <Input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onPressEnter={createProject}
            placeholder="比如：蒸馏某人的客服沟通风格"
          />
          <Select value={depthLevel} onChange={setDepthLevel} options={depthOptions} />
          <Button type="primary" block loading={creating} onClick={createProject}>
            创建任务
          </Button>
          <Text className="persona-model-note">
            模型：{modelConfig.distillModel || "qwen3.7-max"}
          </Text>
        </div>
      </section>

      <section className="governance-pane">
        {activeProject ? (
          <>
            <div className="governance-head">
              <div>
                <Title level={4}>{activeProject.name}</Title>
                <Text>{activeProject.prompt || activeProject.title}</Text>
              </div>
              <Space wrap>
                <Tag>{canUsePublicResearch ? "网络调研" : "材料蒸馏"}</Tag>
                <Tag>{statusLabel(activeProject.status)}</Tag>
              </Space>
            </div>

            {needsMaterials ? (
              <div className="persona-action-card">
                <div>
                  <strong>需要材料</strong>
                  <span>这个人目前无法靠公开信息蒸馏。上传聊天记录、会议纪要、访谈、语音转写或字幕后再生成。</span>
                </div>
                <Button type="primary" loading={uploading} onClick={() => fileInputRef.current?.click()}>
                  上传材料
                </Button>
              </div>
            ) : (
              <div className="persona-action-card persona-action-card-ready">
                <div>
                  <strong>{canUsePublicResearch ? "可以开始网络调研" : "材料已就绪"}</strong>
                  <span>{canUsePublicResearch ? "公开人物会优先使用公开资料，后续也可以补充本地材料。" : "确认材料没问题后，可以进入解析和人工校准。"}</span>
                </div>
                <Button
                  type="primary"
                  loading={runningProjectId === activeProject.id || activeProject.status === "distilling"}
                  disabled={activeProject.status === "distilling"}
                  onClick={runDistill}
                >
                  {activeProject.status === "distilling" ? "蒸馏中..." : activeProject.skillMarkdown ? "重新蒸馏 Skill" : "开始蒸馏并生成 Skill"}
                </Button>
              </div>
            )}

            <div className="review-block">
              <h3>材料</h3>
              <p className="review-tip">已上传 {materialCount} 份。非公开人物必须先有材料，公开人物也可以上传本地材料提高准确度。</p>
              {(activeProject.sources || []).length ? (
                <div className="persona-material-list">
                  {(activeProject.sources || []).map((source, index) => (
                    <div className="persona-material-item" key={`${source.type}-${source.name}-${index}`}>
                      <span>{source.name}</span>
                      <em>{source.type}</em>
                      <small>{source.status}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="review-tip">还没有材料。非公开人物需要先上传材料。</p>
              )}
              <div className="persona-upload-row">
                <Select
                  value={materialType}
                  onChange={setMaterialType}
                  options={[
                    { value: "聊天记录", label: "聊天记录" },
                    { value: "会议纪要", label: "会议纪要" },
                    { value: "访谈问答", label: "访谈问答" },
                    { value: "语音转写", label: "语音转写" },
                    { value: "视频字幕", label: "视频字幕" },
                    { value: "工作文档", label: "工作文档" },
                  ]}
                />
                <input ref={fileInputRef} type="file" multiple onChange={uploadMaterials} hidden />
                <Button loading={uploading} onClick={() => fileInputRef.current?.click()}>
                  上传材料
                </Button>
              </div>
            </div>

            <div className="review-block persona-chat-block">
              <div className="persona-chat-head">
                <div>
                  <h3>和蒸馏人物对话</h3>
                  <p className="review-tip">选择一个已完成蒸馏的人物，用生成的 Skill 作为对话人格。</p>
                  {activeProject.skillDir ? <p className="review-tip">服务器保存目录：{activeProject.skillDir}</p> : skillsDir ? <p className="review-tip">服务器 Skill 根目录：{skillsDir}</p> : null}
                </div>
                <Select
                  value={chatProjectId || undefined}
                  placeholder="选择人物"
                  options={completedProjects.map((project) => ({ value: project.id, label: project.name }))}
                  onChange={(value) => {
                    setChatProjectId(value);
                    setChatMessages([]);
                  }}
                  style={{ minWidth: 180 }}
                />
              </div>
              {selectedChatProject ? (
                <>
                  <div className="persona-chat-messages">
                    {chatMessages.length ? (
                      chatMessages.map((item, index) => (
                        <div className={`persona-chat-message ${item.role === "user" ? "user" : "assistant"}`} key={`${item.role}-${index}`}>
                          <strong>{item.role === "user" ? "你" : selectedChatProject.name}</strong>
                          <p>{item.content}</p>
                        </div>
                      ))
                    ) : (
                      <div className="persona-chat-empty">可以开始问 {selectedChatProject.name} 一个问题。</div>
                    )}
                  </div>
                  <div className="persona-chat-input">
                    <TextArea
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      onPressEnter={(event) => {
                        if (!event.shiftKey) {
                          event.preventDefault();
                          sendPersonaChat();
                        }
                      }}
                      placeholder={`问 ${selectedChatProject.name}：如果是你，会怎么判断？`}
                      autoSize={{ minRows: 2, maxRows: 5 }}
                    />
                    <Button type="primary" loading={chatLoading} onClick={sendPersonaChat}>
                      发送
                    </Button>
                  </div>
                </>
              ) : (
                <div className="persona-chat-empty">还没有可对话的人物。先完成一次蒸馏，就会出现在这里。</div>
              )}
            </div>
          </>
        ) : (
          <div className="empty-state">暂无人物蒸馏项目。</div>
        )}
      </section>
    </div>
  );
}
