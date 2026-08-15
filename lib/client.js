window.__ModuleLoader__.load({
	id: "@haoranwang0921/dsh-session-cleaner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");

		const css = `
.sessdel-wrap { padding: 4px 2px; }
.sessdel-head { font-size: 15px; font-weight: 600; margin: 0 0 4px; color: var(--dsw-alias-label-primary); }
.sessdel-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 12px; }
.sessdel-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.sessdel-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.sessdel-main { min-width: 0; flex: 1; }
.sessdel-title { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sessdel-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sessdel-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.sessdel-tag { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.sessdel-btn { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.sessdel-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.sessdel-btn:disabled { opacity: .55; cursor: default; }
.sessdel-msg { font-size: 12px; margin: 8px 0; }
.sessdel-msg-ok { color: var(--dsw-alias-state-success-primary); }
.sessdel-msg-err { color: var(--dsw-alias-state-error-primary); }
.sessdel-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 8px 0; }
.sessdel-msgs { margin-top: 8px; padding: 8px 10px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.sessdel-msglist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 360px; overflow-y: auto; }
.sessdel-msgrow { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 2px; }
.sessdel-msgrow-click { cursor: pointer; }
.sessdel-msgrole { flex-shrink: 0; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.sessdel-msgtext { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sessdel-arrow { flex-shrink: 0; color: var(--dsw-alias-label-secondary); }
.sessdel-sub { margin-left: 22px; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 4px; }
.sessdel-subrow { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 2px; }
`;
		const tagId = "@haoranwang0921/dsh-session-cleaner/session-cleaner.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@haoranwang0921/dsh-session-cleaner";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** POST one JSON operation to the host half's /api route. */
		async function call(op, payload) {
			const response = await fetch("/api/session-cleaner/" + op, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const text = await response.text();
			if (text === "") return { ok: false, error: "empty-response", message: "服务端返回为空" };
			try {
				return JSON.parse(text);
			} catch {
				return { ok: false, error: "bad-json", message: "服务端返回无法解析" };
			}
		}

		function roleLabel(role) {
			return role === "user" ? "用户" : role === "assistant" ? "助手" : "工具";
		}

		function groupMessages(msgs) {
			const groups = [];
			let current = null;
			for (const m of msgs) {
				if (m.role === "user") {
					current = { user: m, children: [] };
					groups.push(current);
				} else if (current !== null) {
					current.children.push(m);
				} else {
					current = { user: null, children: [m] };
					groups.push(current);
				}
			}
			return groups;
		}

		function SessionCleaner(props) {
			const list = props.useSessions(s => s);
			const [pending, setPending] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			const [message, setMessage] = React.useState(null);
			const [removed, setRemoved] = React.useState([]);
			const [expanded, setExpanded] = React.useState(null);
			const [messages, setMessages] = React.useState({});
			const [expandedMsgs, setExpandedMsgs] = React.useState([]);
			const [loadingMsgs, setLoadingMsgs] = React.useState(false);
			const [msgError, setMsgError] = React.useState(null);
			const [deletingMsg, setDeletingMsg] = React.useState(null);

			const rows = (list.ids || []).map(id => list.byId[id]).filter(s => s !== undefined && !removed.includes(s.id));

			const doDelete = async (id) => {
				setBusy(id);
				setMessage(null);
				try {
					const result = await call("delete-session", { sessionId: id });
					if (result && result.ok === true) {
						setRemoved(prev => [...prev, id]);
						setMessage({ kind: "ok", text: "已永久删除该会话的全部记录" });
						setPending(null);
					} else {
						setMessage({ kind: "err", text: (result && (result.message || result.error)) || "删除失败" });
					}
				} catch (error) {
					setMessage({ kind: "err", text: String(error && error.message ? error.message : error) });
				} finally {
					setBusy(null);
				}
			};

			const toggleMessages = async (id) => {
				if (expanded === id) { setExpanded(null); return; }
				setExpanded(id);
				setMsgError(null);
				if (messages[id] !== undefined) return;
				setLoadingMsgs(true);
				try {
					const result = await call("list-messages", { sessionId: id });
					if (result && result.ok === true) {
						const visible = (result.messages || []).filter(m => !(m.source === "plugin" && m.sourcePlugin === "dsh-session-cleaner"));
						setMessages(prev => ({ ...prev, [id]: visible }));
					} else {
						setMsgError((result && (result.message || result.error)) || "读取消息失败");
					}
				} catch (error) {
					setMsgError(String(error && error.message ? error.message : error));
				} finally {
					setLoadingMsgs(false);
				}
			};

			const removeMessage = async (id, seq, role) => {
				setDeletingMsg(seq);
				setMsgError(null);
				try {
					const result = await call("delete-message", { sessionId: id, seq });
					if (result && result.ok === true) {
						const removedSeqs = Array.isArray(result.shadowed) ? result.shadowed : [seq];
						setMessages(prev => ({ ...prev, [id]: (prev[id] || []).filter(m => !removedSeqs.includes(m.seq)) }));
						setExpandedMsgs(prev => prev.filter(s => !removedSeqs.includes(s)));
						setMessage({ kind: "ok", text: role === "user" ? "已删除该用户消息及其引发的助手与工具消息" : "已删除该条对话记录" });
					} else {
						setMsgError((result && (result.message || result.error)) || "删除失败");
					}
				} catch (error) {
					setMsgError(String(error && error.message ? error.message : error));
				} finally {
					setDeletingMsg(null);
				}
			};

			const toggleMsg = seq => {
				setExpandedMsgs(prev => prev.includes(seq) ? prev.filter(s => s !== seq) : [...prev, seq]);
			};

			const renderSubRow = (sessionId, m) => React.createElement("div", { key: m.seq, className: "sessdel-subrow" },
				React.createElement("span", { className: "sessdel-msgrole" }, roleLabel(m.role)),
				React.createElement("span", { className: "sessdel-msgtext" }, m.preview || "(无文本内容)"),
				React.createElement("button", {
					className: "sessdel-btn sessdel-btn-danger",
					disabled: deletingMsg === m.seq,
					onClick: () => { void removeMessage(sessionId, m.seq, m.role); },
				}, deletingMsg === m.seq ? "删除中…" : "删除"),
			);

			const renderGroup = (sessionId, group, index) => {
				if (group.user === null) {
					return React.createElement("div", { key: "o-" + index },
						group.children.map(m => renderSubRow(sessionId, m)));
				}
				const user = group.user;
				const isOpen = expandedMsgs.includes(user.seq);
				return React.createElement("div", { key: "g-" + user.seq },
					React.createElement("div", { className: "sessdel-msgrow sessdel-msgrow-click", onClick: () => toggleMsg(user.seq) },
						React.createElement("span", { className: "sessdel-arrow" }, isOpen ? "▼" : "▶"),
						React.createElement("span", { className: "sessdel-msgrole" }, "用户"),
						React.createElement("span", { className: "sessdel-msgtext" }, user.preview || "(无文本内容)"),
						React.createElement("button", {
							className: "sessdel-btn sessdel-btn-danger",
							disabled: deletingMsg === user.seq,
							onClick: (e) => { e.stopPropagation(); void removeMessage(sessionId, user.seq, "user"); },
						}, deletingMsg === user.seq ? "删除中…" : "删除(含回复)"),
					),
					isOpen
						? group.children.length === 0
							? React.createElement("div", { className: "sessdel-sub" },
									React.createElement("span", { className: "sessdel-msgtext" }, "（该消息没有引发助手或工具消息）"))
							: React.createElement("div", { className: "sessdel-sub" },
									group.children.map(m => renderSubRow(sessionId, m)))
						: null,
				);
			};

			return React.createElement("div", { className: "sessdel-wrap" },
				React.createElement("h3", { className: "sessdel-head" }, "删除对话记录"),
				React.createElement("p", { className: "sessdel-hint" }, "可删除整个会话；展开会话后按用户消息管理：点击一条用户消息可查看其引发的助手与工具消息并单独删除。删除用户消息会同时删除其全部回复。"),
				message ? React.createElement("div", { className: "sessdel-msg " + (message.kind === "ok" ? "sessdel-msg-ok" : "sessdel-msg-err") }, message.text) : null,
				rows.length === 0
					? React.createElement("div", { className: "sessdel-empty" }, "没有可删除的会话记录")
					: React.createElement("ul", { className: "sessdel-list" },
							rows.map(s => {
								const isCurrent = s.id === list.current;
								const locked = s.running === true || isCurrent;
								const msgs = messages[s.id];
								return React.createElement("li", { key: s.id, className: "sessdel-row" },
									React.createElement("div", { className: "sessdel-main" },
										React.createElement("div", { className: "sessdel-title" }, s.displayTitle || s.title || s.id),
										React.createElement("div", { className: "sessdel-meta" },
											s.id + (s.cwd ? " · " + s.cwd : "") + (s.updatedAt ? " · " + new Date(s.updatedAt).toLocaleString() : ""),
										),
										expanded === s.id
											? React.createElement("div", { className: "sessdel-msgs" },
													loadingMsgs ? React.createElement("div", { className: "sessdel-empty" }, "读取中…") : null,
													msgError ? React.createElement("div", { className: "sessdel-msg sessdel-msg-err" }, msgError) : null,
													msgs !== undefined && msgs.length === 0 && !loadingMsgs
														? React.createElement("div", { className: "sessdel-empty" }, "该会话没有可列出的消息")
														: React.createElement("div", { className: "sessdel-msglist" },
																groupMessages(msgs || []).map((group, index) => renderGroup(s.id, group, index))),
												)
											: null,
									),
									React.createElement("div", { className: "sessdel-actions" },
										locked
											? React.createElement("span", { className: "sessdel-tag" }, isCurrent ? "当前会话" : "运行中")
											: React.createElement(React.Fragment, null,
													React.createElement("button", { className: "sessdel-btn", onClick: () => { void toggleMessages(s.id); } }, expanded === s.id ? "收起消息" : "消息"),
													pending === s.id
														? React.createElement("span", null,
																React.createElement("button", { className: "sessdel-btn sessdel-btn-danger", disabled: busy === s.id, onClick: () => { void doDelete(s.id); } }, busy === s.id ? "删除中…" : "确认删除"),
																React.createElement("button", { className: "sessdel-btn", disabled: busy === s.id, onClick: () => setPending(null) }, "取消"),
															)
														: React.createElement("button", { className: "sessdel-btn sessdel-btn-danger", onClick: () => setPending(s.id) }, "删除"),
												),
									),
								);
							}),
						),
			);
		}

		function apply(ctx) {
			ctx.effect(() => {
				return ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "conversation-cleaner",
					order: 30,
					label: () => "会话管理",
				}, SessionCleaner));
			}, "dsh-session-cleaner: settings section");
		}

		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
