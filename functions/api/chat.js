// This is the backend API proxy running on Cloudflare Functions.
// It securely handles API requests to different AI models.

export async function onRequestPost(context) {
    try {
        // 1. Get request data from the frontend
        const { request, env } = context;
        const { model, messages } = await request.json();

        // 2. Prepare the request for the selected AI model API
        let apiRequest;
        switch (model) {
            case 'gemini':
                // TODO: Replace with actual Google Gemini API call
                // API Key is securely accessed from Cloudflare's environment variables
                const geminiApiKey = env.GEMINI_API_KEY;
                if (!geminiApiKey) throw new Error("GEMINI_API_KEY is not set");
                
                // This is a placeholder. You'll need to structure the request
                // according to the Gemini API documentation.
                apiRequest = {
                    url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${geminiApiKey}`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: messages.map(msg => ({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] })) })
                };
                break;

            case 'chatgpt':
                // TODO: Replace with actual OpenAI API call
                const openaiApiKey = env.OPENAI_API_KEY;
                if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not set");

                apiRequest = {
                    url: 'https://api.openai.com/v1/chat/completions',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${openaiApiKey}`
                    },
                    body: JSON.stringify({
                        model: "gpt-3.5-turbo", // or "gpt-4"
                        messages: messages
                    })
                };
                break;

            case 'deepseek':
                 // TODO: Replace with actual DeepSeek API call
                const deepseekApiKey = env.DEEPSEEK_API_KEY;
                if (!deepseekApiKey) throw new Error("DEEPSEEK_API_KEY is not set");

                apiRequest = {
                    url: 'https://api.deepseek.com/chat/completions',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${deepseekApiKey}`
                    },
                    body: JSON.stringify({
                        model: "deepseek-chat",
                        messages: messages
                    })
                };
                break;

            case 'qwen':
                // TODO: Replace with actual Alibaba Qwen API call
                const qwenApiKey = env.QWEN_API_KEY;
                if (!qwenApiKey) throw new Error("QWEN_API_KEY is not set");
                
                apiRequest = {
                    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${qwenApiKey}`
                    },
                    body: JSON.stringify({
                        model: "qwen-turbo",
                        input: { messages: messages }
                    })
                };
                break;

            default:
                return new Response(JSON.stringify({ error: 'Invalid model selected' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                });
        }

        // 3. Make the actual API call
        const apiResponse = await fetch(apiRequest.url, apiRequest);
        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            console.error(`API Error from ${model}: ${errorText}`);
            throw new Error(`Failed to fetch from ${model} API`);
        }
        const data = await apiResponse.json();

        // 4. Extract the reply from the specific API response structure
        let reply = '';
        switch (model) {
            case 'gemini':
                reply = data.candidates[0].content.parts[0].text;
                break;
            case 'chatgpt':
            case 'deepseek':
                reply = data.choices[0].message.content;
                break;
            case 'qwen':
                reply = data.output.text;
                break;
        }

        // 5. Send the extracted reply back to the frontend
        return new Response(JSON.stringify({ reply }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error in Cloudflare Function:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
