// /root/桌面/aiwebchat/functions/api/chat.js
// worker.js

// 定义支持的大模型供应商，以便更好地组织和扩展
const PROVIDERS = {
    OLLAMA: 'ollama',
    GEMINI: 'gemini',
};

// =========================================================================
// 主请求处理函数 (使用 ES Module export default)
// =========================================================================
export default {
    async fetch(request, env, ctx) { // 添加 ctx 参数，这是 Pages Functions 的标准签名
        try {
            const url = new URL(request.url);
            const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname; // 移除尾部斜杠

            // 仅处理 POST 请求到 /api/chat 路径
            if (request.method === 'POST' && pathname === '/api/chat') {
                return handleChatRequest(request, env);
            }

            // 如果不匹配，则尝试服务静态资产
            return env.ASSETS.fetch(request);
        } catch (error) {
            console.error('Global fetch error:', error);
            return new Response(JSON.stringify({ error: `Internal server error: ${error.message}` }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
    }
};


// =========================================================================
// Gemini 流式响应转换器
// 将 Gemini 的流式 JSON 转换为 OpenAI 兼容的 SSE 格式
// =========================================================================
function transformGeminiStreamToSSE() {
    let buffer = '';
    const decoder = new TextDecoder();

    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });

            // Gemini 的流通常以 "data: " 开头，并且每个 JSON 对象后有两个换行符
            // 我们需要处理可能不完整的 JSON 数据块
            const lines = buffer.split('\n\n');

            // 保留最后一个可能不完整的块在缓冲区中
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const rawJson = line.substring(6);
                        const geminiChunk = JSON.parse(rawJson);
                        const textContent = geminiChunk.candidates?.[0]?.content?.parts?.[0]?.text || '';

                        if (textContent) {
                            // 构建 OpenAI 兼容的 SSE 负载
                            const ssePayload = {
                                choices: [{
                                    delta: { content: textContent },
                                    index: 0,
                                    finish_reason: null
                                }]
                            };
                            // 将 SSE 格式的字符串推送到流中
                            controller.enqueue(`data: ${JSON.stringify(ssePayload)}\n\n`);
                        }
                    } catch (e) {
                        console.error('Error parsing Gemini stream chunk:', e, 'Chunk:', line);
                    }
                }
            }
        },
        flush(controller) {
            // 流结束时，发送一个 [DONE] 消息，以符合 OpenAI SSE 规范
            controller.enqueue('data: [DONE]\n\n');
        }
    });
}


// =========================================================================
// 聊天请求处理函数
// 这是核心逻辑，根据模型选择不同的后端 API
// =========================================================================
async function handleChatRequest(request, env) {
    // 确保请求体为 JSON
    const contentType = request.headers.get('Content-Type');
    if (!contentType || !contentType.includes('application/json')) {
        return new Response(JSON.stringify({ error: 'Unsupported Media Type: Request must be JSON' }), {
            status: 415,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    let requestBody;
    try {
        requestBody = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const { model, messages, stream, image: imageBase64 } = requestBody; // 提取请求中的关键信息

    if (!model) {
        return new Response(JSON.stringify({ error: 'Missing "model" in request body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return new Response(JSON.stringify({ error: 'Missing or empty "messages" array in request body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // --- 多模态处理：如果请求中包含图片，则修改最后一条消息 ---
    const processedMessages = [...messages]; // 创建消息的副本，避免直接修改原始请求体
    if (imageBase64 && processedMessages.length > 0) { // 这里修正了一个明显的错别字：imageBase66 应为 imageBase64
        const lastMessage = processedMessages[processedMessages.length - 1];
        if (lastMessage.role === 'user') {
            const match = imageBase64.match(/^data:(image\/.+);base64,(.+)$/);
            if (match) {
                const mimeType = match[1];
                const pureBase64 = match[2];

                if (model.startsWith('gemini')) {
                    lastMessage.parts = [
                        { text: lastMessage.content },
                        { inline_data: { mime_type: mimeType, data: pureBase64 } }
                    ];
                    delete lastMessage.content; // Gemini API 使用 parts 字段，移除 content
                } else {
                    lastMessage.content = [
                        { type: 'text', text: lastMessage.content },
                        { type: 'image_url', image_url: { url: imageBase64 } }
                    ];
                }
            }
        }
    }

    // --- 构建 API 配置 ---
    let apiConfig;
    try {
        apiConfig = buildApiConfig(model, processedMessages, stream, env);
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    // --- 路由器逻辑：根据 apiConfig 发送请求到后端 ---
    try {
        const fetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiConfig.apiKey ? { 'Authorization': `Bearer ${apiConfig.apiKey}` } : {})
            },
            body: JSON.stringify(apiConfig.body),
        };

        let finalEndpoint = apiConfig.endpoint;
        if (apiConfig.provider === PROVIDERS.GEMINI) {
            // Gemini 的 API Key 通过 URL 参数传递
            const urlParams = new URLSearchParams();
            if (stream) {
                urlParams.append('alt', 'sse');
            }
            urlParams.append('key', apiConfig.apiKey);

            // 统一构建 Gemini API 的操作路径
            const operation = stream ? 'streamGenerateContent' : 'generateContent';
            finalEndpoint = `${apiConfig.endpoint}:${operation}?${urlParams.toString()}`;
            delete fetchOptions.headers['Authorization'];
        }

        const backendResponse = await fetch(finalEndpoint, fetchOptions);

        // --- 流式响应处理 ---
        if (stream) {
            let responseStream;
            if (apiConfig.provider === PROVIDERS.GEMINI) {
                responseStream = backendResponse.body.pipeThrough(transformGeminiStreamToSSE());
            } else {
                responseStream = backendResponse.body;
            }

            return new Response(responseStream, {
                status: backendResponse.status,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Access-Control-Allow-Origin': '*',
                }
            });
        }

        // --- 非流式响应处理 ---
        let data;
        let rawErrorText = null; // 用于存储原始错误文本
        let contentTypeHeader = backendResponse.headers.get('Content-Type');

        try {
            data = await backendResponse.json();
        } catch (jsonError) {
            // 如果 JSON 解析失败，立即读取原始文本作为错误信息
            rawErrorText = await backendResponse.text();
            console.error(`Backend API returned non-JSON or malformed JSON for model ${model} (${apiConfig.provider}) (Status: ${backendResponse.status}, Content-Type: ${contentTypeHeader || 'None'}):`, rawErrorText);
        }

        if (!backendResponse.ok) {
            // 如果请求失败，优先使用已捕获的原始错误文本
            const errorDetails = rawErrorText ?? JSON.stringify(data?.error) ?? 'No error details available.';

            // 专门处理 429 Too Many Requests 错误
            if (backendResponse.status === 429) {
                console.error(`Rate limit exceeded for model ${model} (${apiConfig.provider}). Status: 429`);
                const errorPayload = {
                    error: `请求过于频繁 (速率限制)，请稍等片刻后再试。模型: ${model}`,
                    statusCode: 429,
                    provider: apiConfig.provider,
                    originalError: errorDetails
                };
                return new Response(JSON.stringify(errorPayload, null, 2), {
                    status: 429,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            console.error(`Backend API returned error status for model ${model} (${apiConfig.provider}): Status ${backendResponse.status}, Raw Response: ${errorDetails}`);
            return new Response(JSON.stringify({
                error: `Backend API error for model ${model} (${apiConfig.provider}): Status ${backendResponse.status}. Details: ${errorDetails.substring(0, 500)}`,
                statusCode: backendResponse.status,
                originalResponse: errorDetails
            }, null, 2), {
                status: backendResponse.status,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        if (data && data.error) { // 确保 data 存在
            console.error(`Backend API reported error for model ${model} (${apiConfig.provider}):`, data.error);
            return new Response(JSON.stringify({
                error: `Backend API error for model ${model} (${apiConfig.provider}): ${data.error.message || JSON.stringify(data.error)}`,
                statusCode: backendResponse.status,
                originalResponse: data
            }, null, 2), {
                status: backendResponse.status,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        let replyContent;
        if (apiConfig.provider === PROVIDERS.GEMINI) {
            replyContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
        } else {
            replyContent = data.choices?.[0]?.message?.content;
        }


        if (replyContent === undefined) {
            console.warn(`Unexpected backend response structure for model ${model} (${apiConfig.provider}):`, data);
            return new Response(JSON.stringify({ error: `Unexpected response from ${apiConfig.provider} for model ${model}` }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        return new Response(JSON.stringify({ reply: replyContent }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });

    } catch (error) {
        console.error(`Worker internal error during backend fetch for model ${model}:`, error);
        return new Response(JSON.stringify({ error: `Worker internal error: ${error.message}` }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

/**
 * 根据模型和消息构建 API 请求配置。
 * @param {string} model - 模型名称。
 * @param {Array<Object>} messages - 消息数组。
 * @param {boolean} stream - 是否流式传输。
 * @param {Object} env - 环境变量。
 * @returns {Object} API 配置对象。
 * @throws {Error} 如果模型不支持。
 */
function buildApiConfig(model, messages, stream, env) {
    let apiConfig = {};

    if (model.startsWith('gemini')) {
        if (!env.GEMINI_API_KEY) {
            throw new Error('Server configuration error: GEMINI_API_KEY is not set for Gemini model.');
        }

        // --- Gemini 消息处理：确保角色交替并合并连续消息 ---

        // 1. 过滤掉无效或空内容的消息
        let processed = messages.filter(msg => (msg.content || (msg.parts && msg.parts.some(p => p.text || p.inline_data))));

        // 2. 确保第一条消息是 'user'
        const firstUserIndex = processed.findIndex(msg => msg.role === 'user');
        if (firstUserIndex > 0) {
            processed = processed.slice(firstUserIndex);
        } else if (firstUserIndex === -1) {
            throw new Error("Invalid chat history: No user messages found.");
        }

        // 3. 合并连续的同角色消息，确保角色交替
        const mergedMessages = [];
        for (const msg of processed) {
            const lastMsg = mergedMessages.length > 0 ? mergedMessages[mergedMessages.length - 1] : null;
            const currentRole = msg.role === 'user' ? 'user' : 'model'; // 标准化当前角色
            const isTextMessage = !(msg.parts && msg.parts.some(p => p.inline_data));

            if (lastMsg && lastMsg.role === currentRole && isTextMessage) {
                // 合并纯文本内容
                const contentToAppend = msg.content || (msg.parts && msg.parts[0]?.text) || '';
                lastMsg.parts[0].text += "\n" + contentToAppend;
            } else {
                // 直接添加，并确保格式正确
                let parts = msg.parts;
                if (!parts) {
                    parts = [{ text: msg.content || '' }];
                }
                mergedMessages.push({ role: currentRole, parts });
            }
        }

        if (mergedMessages.length === 0) {
            throw new Error("Invalid chat history: Resulting messages are empty.");
        }

        apiConfig = {
            provider: PROVIDERS.GEMINI,
            endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}`,
            apiKey: env.GEMINI_API_KEY,
            modelName: model,
            body: {
                contents: mergedMessages,
            }
        };
    } else if (model.startsWith('deepseek') || model.startsWith('gpt-') || model.startsWith('qwen') || model.startsWith('ollama-')) {
        // 修改这里以支持多个 Ollama 服务器
        let ollamaBaseUrl = env.OLLAMA_API_BASE_URL; // 默认使用 OLLAMA_API_BASE_URL

        // 尝试从模型名称中提取 Ollama 服务器地址
        // 例如：model: "ollama-http://192.168.1.100:11434/llama2"
        const ollamaUrlPrefix = 'ollama-http';
        if (model.startsWith(ollamaUrlPrefix)) {
            const parts = model.split('/');
            if (parts.length >= 3) {
                // 提取完整的 URL，例如 "http://192.168.1.100:11434"
                ollamaBaseUrl = parts[0] + '//' + parts[1].split('-')[1] + '/' + parts[2]; // 重新构建 URL
                model = model.substring(ollamaUrlPrefix.length + ollamaBaseUrl.length - ollamaUrlPrefix.length); // 提取实际的模型名
            }
        }
        
        if (!ollamaBaseUrl) {
            throw new Error('Server configuration error: OLLAMA_API_BASE_URL or a valid Ollama URL in model name is not set.');
        }

        // --- Ollama/OpenAI 消息处理：统一消息格式 ---
        const ollamaMessages = messages.map(msg => {
            // 如果 content 已经是数组 (多模态)，直接返回
            if (Array.isArray(msg.content)) {
                return msg;
            }
            // 如果是纯文本，也包装成数组，以保持格式统一
            return {
                ...msg,
                content: [{ type: 'text', text: msg.content || '' }]
            };
        });

        apiConfig = {
            provider: PROVIDERS.OLLAMA,
            endpoint: `${ollamaBaseUrl}/v1/chat/completions`,
            apiKey: null, // Ollama 通常不需要 API Key，或者自行处理
            modelName: model.startsWith('ollama-') ? model.substring('ollama-'.length) : model, // 提取实际的模型名称
            body: {
                model: model.startsWith('ollama-') ? model.substring('ollama-'.length) : model,
                messages: ollamaMessages,
                stream: stream !== undefined ? stream : true,
            }
        };
    } else {
        throw new Error(`Unsupported model: ${model}`);
    }
    return apiConfig;
}
