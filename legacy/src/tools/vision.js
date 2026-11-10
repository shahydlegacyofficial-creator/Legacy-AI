/**
 * "Look at this." (v1.68)
 *
 * She opens the camera herself, takes one frame, and sees it inside the same
 * turn. No panel to open, no button to press.
 *
 * The image comes back through the tool result — see the note in agent.js —
 * which is why this reads as one answer rather than "let me look" followed by
 * a second reply that has forgotten why it was looking.
 */
import { registerTool } from './registry.js';
import { requestLook } from '../eyes.js';

registerTool({
  name: 'look_through_camera',
  description:
    "Take a picture through Shahyd's camera and look at it. Use whenever he " +
    'shows you something or asks what something is — "look at this", "what is ' +
    'this cable", "read this label", "does this look right". She opens the ' +
    'camera herself; he does not need to turn it on first. Say what he asked ' +
    'about in `about` so the picture is read with the right question in mind.',
  inputSchema: {
    type: 'object',
    properties: {
      about: { type: 'string', description: 'What he wants to know about it, in his words.' },
    },
  },
  handler: async ({ about }) => {
    const shot = await requestLook({ source: 'camera', question: about ?? '' });
    if (shot.error) return shot.error;
    return {
      image: shot,
      text: about?.trim()
        ? `This is what the camera sees. He asked: ${about.trim()}`
        : 'This is what the camera sees. Tell him what it is and anything useful you know about it.',
    };
  },
});

registerTool({
  name: 'look_at_screen',
  description:
    "Take a picture of Shahyd's screen and look at it. Use when he asks what " +
    'is on screen, to read something to him, or to check what an error says. ' +
    'Screen sharing has to be running already — unlike the camera, a browser ' +
    'will not start it without him choosing what to share.',
  inputSchema: {
    type: 'object',
    properties: {
      about: { type: 'string', description: 'What he wants to know, in his words.' },
    },
  },
  handler: async ({ about }) => {
    const shot = await requestLook({ source: 'screen', question: about ?? '' });
    if (shot.error) return shot.error;
    return {
      image: shot,
      text: about?.trim()
        ? `This is his screen. He asked: ${about.trim()}`
        : 'This is his screen. Describe what matters and read anything important.',
    };
  },
});
