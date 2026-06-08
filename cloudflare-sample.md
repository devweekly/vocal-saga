curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/v1/chat/completions \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
  "model": "deepseek/deepseek-v4-pro",
  "messages": [
    {
      "content": "What is the capital of France?",
      "role": "user"
    }
  ]
}'