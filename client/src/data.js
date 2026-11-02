export const skillNames=['Speaking','Listening','Reading','Writing','Grammar','Vocabulary','Pronunciation','Fluency','Comprehension','Conversation','Sentence formation','Spelling','Intonation','Functional English'];
export const nav=[['home','Today'],['path','My path'],['coach','AI coach'],['practice','Practice studio'],['world','Immersion world'],['review','Review'],['progress','My progress']];
export const activities=[
 {id:'conversation',title:'AI conversation',desc:'Open-ended conversation when live AI is connected',icon:'MessageCircle',tag:'Speak',color:'mint'},
 {id:'simulation',title:'Real-world simulations',desc:'Make decisions inside guided, changing situations',icon:'Compass',tag:'Immersive',color:'gold'},
 {id:'pronunciation',title:'Pronunciation lab',desc:'Hear it, repeat it, compare your transcript',icon:'AudioLines',tag:'Voice',color:'blue'},
 {id:'story',title:'Interactive stories',desc:'Choose the next turn and change the scene',icon:'BookOpen',tag:'Explore',color:'lilac'},
 {id:'writing',title:'Writing studio',desc:'Build clearer sentences with guided feedback',icon:'PenLine',tag:'Create',color:'coral'},
 {id:'group',title:'Group room',desc:'Practise with people while the coach observes',icon:'Users',tag:'Together',color:'mint'}
];
export const scenarios=[
 {id:'airport',title:'The airport',place:'Terminal 2 · Check-in desk',level:'A2',icon:'Plane',desc:'Check in, ask questions, and handle a surprise change.',goal:'Get your boarding pass and find your gate.',words:['boarding pass','luggage','gate','delayed'],opening:'Good morning! May I see your passport and ticket, please?',hint:'Try: “Here is my passport. I have one bag.”',event:'Your flight has been delayed by 45 minutes. Ask about the new departure time.',roles:'Passenger ↔ Airline agent'},
 {id:'cafe',title:'At the café',place:'The little corner café',level:'A1',icon:'Coffee',desc:'Order a drink and adjust your order politely.',goal:'Order a drink and check the price.',words:['order','small','please','how much'],opening:'Hi there! What would you like to order today?',hint:'Try: “I would like a small coffee, please.”',event:'We have run out of your first choice. Ask for an alternative.',roles:'Customer ↔ Barista'},
 {id:'interview',title:'The interview',place:'A bright meeting room',level:'B1',icon:'BriefcaseBusiness',desc:'Tell your story and respond to a follow-up question.',goal:'Explain your experience with one concrete example.',words:['experience','project','challenge','result'],opening:'Welcome! Could you tell me about yourself and one project you are proud of?',hint:'Try: “I worked on… My role was… The result was…”',event:'The interviewer asks how you handled a difficult deadline.',roles:'Candidate ↔ Interviewer'},
 {id:'investor',title:'Pitch your idea',place:'Founders’ meeting room',level:'B2',icon:'Lightbulb',desc:'Explain the problem, your solution, and the market.',goal:'Deliver a clear 60-second pitch and answer a challenge.',words:['problem','solution','customer','traction'],opening:'You have one minute. What problem are you solving, and for whom?',hint:'Try: “We help [customer] solve [problem] by [solution].”',event:'The investor asks: What evidence shows customers need this?',roles:'Founder ↔ Investor'},
 {id:'hotel',title:'Hotel check-in',place:'Hotel reception',level:'A2',icon:'Building2',desc:'Confirm a reservation and solve a room mix-up.',goal:'Find your reservation and request a suitable room.',words:['reservation','booking','room','available'],opening:'Good evening. Do you have a reservation with us?',hint:'Try: “Yes, I booked a room for two nights.”',event:'The room is not ready yet. Ask what options are available.',roles:'Guest ↔ Receptionist'},
 {id:'client',title:'Freelancer & client',place:'Project kickoff call',level:'B1',icon:'Laptop2',desc:'Clarify the brief, timeline, and next steps.',goal:'Ask two clarifying questions and agree on a next step.',words:['brief','deadline','scope','deliverable'],opening:'Thanks for joining. We need a new landing page. Where should we start?',hint:'Try: “What is the main goal, and when do you need the first draft?”',event:'The client changes the deadline. Negotiate a realistic scope.',roles:'Freelancer ↔ Client'}
];
export const units=[
 {id:'foundation',title:'First words, real moments',level:'ABC → A1',desc:'Build greetings, sounds, and everyday sentences.',count:'8 missions',color:'mint'},
 {id:'everyday',title:'Find your voice',level:'A1 → A2',desc:'Speak through daily routines, places, and plans.',count:'12 missions',color:'blue'},
 {id:'independent',title:'The world opens up',level:'A2 → B1',desc:'Navigate travel, work, and longer conversations.',count:'14 missions',color:'gold'},
 {id:'confident',title:'Make your point',level:'B1 → B2',desc:'Explain ideas, negotiate, and speak with nuance.',count:'16 missions',color:'lilac'},
 {id:'mastery',title:'Precision & presence',level:'B2 → C2',desc:'Develop style, persuasion, and advanced fluency.',count:'18 missions',color:'coral'}
];
export const engineGroups={
 'Learner & learning':['Learner model','Assessment','Adaptive learning','Curriculum','Learning plan','Recommendation','Progress','Analytics','Memory & review','Gamification'],
 'Language skills':['Vocabulary','Grammar','Reading','Listening','Writing','Speaking','Pronunciation','Fluency','Comprehension','Phonics','Functional English'],
 'AI guidance':['Teacher','Coach','Conversation','Conversation director','Feedback','Hints','AI memory','Evaluation'],
 'Immersion':['Story','Role-play','Simulation','Dynamic events','World state','AI characters','Group conversation'],
 'Media':['Audio','Text to speech','Speech to text','Alignment','Subtitles','Animation','Character','Asset'],
 'Knowledge & governance':['Language registry','Knowledge graph','Content ingestion','Source registry','License verification','Quality','Admin & CMS'],
 'Platform intelligence':['Source discovery','Content gaps','Experiments','A/B testing','Model evaluation','Curriculum optimization','Content generation','Improvement orchestrator']
};
export const initialProfile={name:'',goal:'Travel & everyday life',minutes:20,level:'A2',skills:{Speaking:46,Listening:55,Reading:61,Writing:40,Grammar:48,Vocabulary:52,Pronunciation:43,Fluency:42},xp:0,streak:0,completed:[],sessions:[],reviews:[],evidence:{},assessmentDone:false,language:'en',uiLanguage:'en',lastActive:''};
export const languagePacks=[{code:'en',name:'English',native:'English',state:'active'},{code:'de',name:'German',native:'Deutsch',state:'planned'},{code:'fr',name:'French',native:'Français',state:'planned'},{code:'es',name:'Spanish',native:'Español',state:'planned'},{code:'ar',name:'Arabic',native:'العربية',state:'planned'}];
