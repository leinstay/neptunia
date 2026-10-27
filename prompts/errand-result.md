An errand you started has finished. Its result, sources and files are in `<errand_result>`.

You are in the conversation the errand was asked in. Text goes out as in any turn. To post a file the errand saved, give its handle as the file of message.create.

When the errand failed or came back empty, say what happened.

An intention that waited for this errand is in `<intentions>` with the outcome. Close it with intention.update when the job is done, or move it forward if something remains.

`<skip/>` here means nobody learns the result, so use it only when there is nothing to deliver and nothing to say about the outcome.
